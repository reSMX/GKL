from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from rkn_registry import load_rkn_entries


ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT.parent.parent / "data" / "default-bundle.json"
TOKEN_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё]+", re.UNICODE)
TOKEN_CHAR_RE = re.compile(r"[а-яёa-z0-9]", re.IGNORECASE)
CONFUSABLE_MAP = {
    "@": "а",
    "0": "о",
    "1": "и",
    "3": "з",
    "4": "ч",
    "6": "б",
    "8": "в",
    "a": "а",
    "c": "с",
    "e": "е",
    "h": "н",
    "k": "к",
    "m": "м",
    "o": "о",
    "p": "р",
    "t": "т",
    "x": "х",
    "y": "у",
}
PROFANE_SUBSTRINGS = (
    "бля",
    "бляд",
    "говн",
    "дерьм",
    "долбоеб",
    "жоп",
    "залуп",
    "манд",
    "муд",
    "нах",
    "педик",
    "пидар",
    "пидор",
    "пидр",
    "пизд",
    "сук",
    "хер",
    "хуй",
    "хуе",
    "хуя",
    "хую",
    "хуйн",
    "хуев",
    "хуищ",
    "хуяч",
    "хуяр",
    "хули",
)
EB_PATTERNS = (
    re.compile(r"^[её]б", re.IGNORECASE),
    re.compile(r"^(?:вы|за|до|на|по|про|под|пере|об|от|с|съ|вз|въ|из|изъ|раз|у|при|недо|подъ)[её]б", re.IGNORECASE),
    re.compile(r"[её]б(?:а|л|н|т|уч|ош|аш|ун|ыр|от|ок|ец|арь|ист|лив|ищ|ц|ст|ти|ля|ло|ель|аль|ан)", re.IGNORECASE),
)


def read_text_source(path_or_url: str) -> str:
    if urlparse(path_or_url).scheme in {"http", "https"}:
        last_error = None
        for _ in range(5):
            try:
                request = Request(path_or_url, headers={"User-Agent": "CenzControlUpdater/1.0"})
                with urlopen(request, timeout=60) as response:
                    return response.read().decode("utf-8")
            except Exception as error:
                last_error = error
                time.sleep(2)
        raise last_error

    return (ROOT / path_or_url).read_text(encoding="utf-8")


def read_json_source(path_or_url: str):
    return json.loads(read_text_source(path_or_url))


def resolve_source_path(source: str) -> str:
    if urlparse(source).scheme in {"http", "https"}:
        return source

    candidate = Path(source)
    if candidate.exists():
        return str(candidate.resolve())

    return str((ROOT / source).resolve())


def normalize_character(character: str) -> str:
    lowered = character.lower()
    return CONFUSABLE_MAP.get(lowered, lowered)


def normalize_term(term: str) -> str:
    normalized = []
    for character in str(term or ""):
        mapped = normalize_character(character)
        if TOKEN_CHAR_RE.fullmatch(mapped):
            normalized.append(mapped)
    return "".join(normalized)


def canonicalize_term(term: str) -> str:
    return normalize_term(term).replace("ё", "е")


def looks_profane(term: str) -> bool:
    canonical = canonicalize_term(term)
    if len(canonical) < 3:
        return False

    if any(part in canonical for part in PROFANE_SUBSTRINGS):
        return True

    return any(pattern.search(canonical) for pattern in EB_PATTERNS)


def iter_line_terms(line: str):
    for chunk in TOKEN_RE.findall(str(line or "")):
        term = normalize_term(chunk)
        if term:
            yield term


def extract_profane_terms(lines: list[str]) -> list[str]:
    terms = set()
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        for term in iter_line_terms(stripped):
            if looks_profane(term):
                terms.add(term)

    return sorted(terms)


def make_exact_term_pattern(term: str) -> str:
    parts = []
    for character in term:
        if character in {"е", "ё"}:
            parts.append("[её]")
        else:
            parts.append(re.escape(character))
    return "".join(parts)


def load_blocked_sites(config: dict, rkn_source: str | None, rkn_headers: str | None, rkn_format: str) -> list[dict]:
    blocked_sites = []

    for item in config.get("blocked_sites", []):
        entries = [
            line.strip().lower()
            for line in read_text_source(item["path"]).splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        for index, value in enumerate(entries, start=1):
            blocked_sites.append({
                "id": f"{item.get('source', 'source')}-{index}",
                "type": item.get("type", "domain"),
                "value": value,
                "source": item.get("source", "unknown"),
                "note": item.get("note", "Собрано скриптом build_bundle.py")
            })

    rkn_config = config.get("rkn_registry", {})
    effective_rkn_source = rkn_source or rkn_config.get("source", "")
    use_rkn = bool(rkn_source) or bool(rkn_config.get("enabled"))
    if use_rkn and effective_rkn_source:
        blocked_sites.extend(
            load_rkn_entries(
                source=resolve_source_path(effective_rkn_source),
                source_label=rkn_config.get("source_label", "rkn_registry"),
                input_format=rkn_format or rkn_config.get("format", "auto"),
                headers_path=rkn_headers or rkn_config.get("headers_path") or None
            )
        )

    deduped = []
    seen = set()
    for entry in blocked_sites:
        key = (entry["type"], entry["value"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    return deduped


def load_dictionary(config: dict) -> list[dict]:
    dictionary = []

    for item in config.get("dictionary", []):
        dictionary.extend(read_json_source(item["path"]))

    source_config = config.get("manual_profane_terms", {})
    if source_config.get("path"):
        terms = extract_profane_terms(read_text_source(source_config["path"]).splitlines())
        if terms:
            dictionary.append({
                "id": "manual-profane-vocabulary",
                "lemma": "Ручной неизменяемый словарь матов проекта",
                "severity": source_config.get("severity", "high"),
                "replacement": source_config.get("replacement", "грубое выражение"),
                "patterns": [make_exact_term_pattern(term) for term in terms]
            })

    return dictionary


def load_exceptions(config: dict) -> list[str]:
    exceptions = []
    for item in config.get("exceptions", []):
        entries = [
            line.strip().lower()
            for line in read_text_source(item["path"]).splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        exceptions.extend(entries)

    return sorted(set(exceptions))


def build_bundle(config_path: Path, rkn_source: str | None, rkn_headers: str | None, rkn_format: str) -> dict:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    blocked_sites = load_blocked_sites(config, rkn_source=rkn_source, rkn_headers=rkn_headers, rkn_format=rkn_format)
    dictionary = load_dictionary(config)
    exceptions = load_exceptions(config)

    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "version": timestamp.replace(":", "").replace("-", ""),
        "updatedAt": timestamp,
        "metadata": {
            "sourceLabel": "generated-by-updater",
            "checkedAt": timestamp,
            "notes": "Bundle сформирован локальным скриптом, включает weekly upstream из Re-filter-lists, статичный adult-список и ручной словарь матов."
        },
        "blockedSites": blocked_sites,
        "dictionary": dictionary,
        "exceptions": exceptions
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Сборка bundle-файла для Cenz Control")
    parser.add_argument("--config", default=str(ROOT / "sources.json"), help="Путь к конфигурации источников")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Куда сохранить итоговый bundle JSON")
    parser.add_argument("--rkn-source", default="", help="Путь к выгрузке РКН или официальный URL выгрузки")
    parser.add_argument("--rkn-format", default="auto", help="Формат выгрузки РКН: auto, xml, csv, json, txt")
    parser.add_argument("--rkn-headers", default="", help="JSON-файл с заголовками для авторизованной загрузки выгрузки РКН")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    output_path = Path(args.output).resolve()

    bundle = build_bundle(
        config_path=config_path,
        rkn_source=args.rkn_source or None,
        rkn_headers=args.rkn_headers or None,
        rkn_format=args.rkn_format
    )
    output_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Bundle saved to {output_path}")
    print(f"Blocked sites: {len(bundle['blockedSites'])}")
    print(f"Dictionary rules: {len(bundle['dictionary'])}")
    print(f"Exceptions: {len(bundle['exceptions'])}")


if __name__ == "__main__":
    main()
