from __future__ import annotations

import csv
import gzip
import io
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
HOST_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$|^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$", re.IGNORECASE)
TAG_HINTS = {
    "domain": "domain",
    "domainname": "domain",
    "hostname": "domain",
    "host": "domain",
    "site": "domain",
    "ip": "domain",
    "ipaddress": "domain",
    "url": "url",
    "uri": "url",
    "page": "url",
    "path": "url",
    "resource": "url",
}


def load_source_bytes(source: str, headers_path: str | None = None) -> bytes:
    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
      headers = {"User-Agent": "CenzControlUpdater/1.0"}
      if headers_path:
          headers.update(json.loads(Path(headers_path).read_text(encoding="utf-8")))
      request = Request(source, headers=headers)
      with urlopen(request) as response:
          return response.read()
    return Path(source).read_bytes()


def unpack_source_bytes(payload: bytes, source_name: str) -> tuple[bytes, str]:
    lower_name = source_name.lower()
    if lower_name.endswith(".gz"):
        return gzip.decompress(payload), source_name[:-3]

    if lower_name.endswith(".zip") or payload[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            candidates = [
                name
                for name in archive.namelist()
                if not name.endswith("/") and name.lower().endswith((".xml", ".csv", ".txt", ".json"))
            ]
            if not candidates:
                raise ValueError("В архиве РКН не найден подходящий файл с выгрузкой.")
            chosen = sorted(candidates)[0]
            return archive.read(chosen), chosen

    return payload, source_name


def detect_format(source_name: str, payload: bytes, input_format: str) -> str:
    if input_format and input_format != "auto":
        return input_format

    lower_name = source_name.lower()
    if lower_name.endswith(".xml"):
        return "xml"
    if lower_name.endswith(".json"):
        return "json"
    if lower_name.endswith(".csv"):
        return "csv"
    if lower_name.endswith(".txt"):
        return "txt"

    stripped = payload.lstrip()
    if stripped.startswith(b"<"):
        return "xml"
    if stripped.startswith(b"{") or stripped.startswith(b"["):
        return "json"
    return "txt"


def load_rkn_entries(
    source: str,
    source_label: str = "rkn_registry",
    input_format: str = "auto",
    headers_path: str | None = None,
) -> list[dict]:
    raw_bytes = load_source_bytes(source, headers_path=headers_path)
    unpacked_bytes, effective_name = unpack_source_bytes(raw_bytes, source)
    detected_format = detect_format(effective_name, unpacked_bytes, input_format)
    text = unpacked_bytes.decode("utf-8-sig", errors="replace")

    if detected_format == "xml":
        entries = parse_xml(text)
    elif detected_format == "json":
        entries = parse_json(text)
    elif detected_format == "csv":
        entries = parse_csv(text)
    else:
        entries = parse_text(text)

    normalized = normalize_entries(entries, source_label=source_label)
    return normalized


def parse_xml(text: str) -> list[tuple[str, str]]:
    root = ET.fromstring(text)
    collected: list[tuple[str, str]] = []
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower()
        if list(element):
            continue

        value = (element.text or "").strip()
        if not value:
            continue

        if tag in TAG_HINTS:
            collected.append((TAG_HINTS[tag], value))
            continue

        guessed = guess_type(value)
        if guessed:
            collected.append((guessed, value))

    if collected:
        return collected

    return extract_with_regex(text)


def parse_json(text: str) -> list[tuple[str, str]]:
    payload = json.loads(text)
    collected: list[tuple[str, str]] = []

    def walk(node, key_hint: str | None = None) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, key.lower())
            return
        if isinstance(node, list):
            for item in node:
                walk(item, key_hint)
            return
        if not isinstance(node, str):
            return

        value = node.strip()
        if not value:
            return

        if key_hint and key_hint in TAG_HINTS:
            collected.append((TAG_HINTS[key_hint], value))
            return

        guessed = guess_type(value)
        if guessed:
            collected.append((guessed, value))

    walk(payload)
    return collected


def parse_csv(text: str) -> list[tuple[str, str]]:
    collected: list[tuple[str, str]] = []
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        for key, value in row.items():
            if value is None:
                continue
            raw = value.strip()
            if not raw:
                continue

            key_hint = (key or "").strip().lower()
            if key_hint in TAG_HINTS:
                collected.append((TAG_HINTS[key_hint], raw))
                continue

            guessed = guess_type(raw)
            if guessed:
                collected.append((guessed, raw))

    return collected


def parse_text(text: str) -> list[tuple[str, str]]:
    collected: list[tuple[str, str]] = []
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        guessed = guess_type(raw)
        if guessed:
            collected.append((guessed, raw))

    if collected:
        return collected

    return extract_with_regex(text)


def extract_with_regex(text: str) -> list[tuple[str, str]]:
    collected: list[tuple[str, str]] = []
    for match in URL_RE.findall(text):
        collected.append(("url", match))
    for token in re.findall(r"[A-Za-z0-9.-]+\.[A-Za-z]{2,63}", text):
        collected.append(("domain", token))
    return collected


def guess_type(value: str) -> str | None:
    if URL_RE.match(value):
        return "url"

    candidate = value.strip().lower()
    candidate = candidate.strip(";,")
    if HOST_RE.match(candidate):
        return "domain"
    return None


def normalize_entries(entries: list[tuple[str, str]], source_label: str) -> list[dict]:
    result: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for preferred_type, raw_value in entries:
        for value in split_values(raw_value):
            normalized = normalize_value(value, preferred_type)
            if not normalized:
                continue

            key = (normalized["type"], normalized["value"])
            if key in seen:
                continue
            seen.add(key)

            normalized["id"] = f"{source_label}-{len(result) + 1}"
            normalized["source"] = source_label
            normalized["note"] = "Получено из выгрузки официального реестра РКН."
            result.append(normalized)

    return result


def split_values(raw_value: str) -> list[str]:
    return [part.strip() for part in re.split(r"[\s;,]+", raw_value) if part.strip()]


def normalize_value(value: str, preferred_type: str) -> dict | None:
    candidate = value.strip().strip(";,").lower()
    if not candidate:
        return None

    if preferred_type == "url" or URL_RE.match(candidate):
        parsed = urlparse(candidate)
        host = parsed.netloc.lower()
        path = parsed.path or ""
        query = f"?{parsed.query}" if parsed.query else ""
        if not host:
            return None
        if path or query:
            return {"type": "url-contains", "value": f"{host}{path}{query}"}
        return {"type": "domain", "value": host}

    if HOST_RE.match(candidate):
        return {"type": "domain", "value": candidate}

    return None
