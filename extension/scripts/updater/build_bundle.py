from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

from rkn_registry import load_rkn_entries


ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT.parent.parent / "data" / "default-bundle.json"


def read_text_source(path_or_url: str) -> str:
    if urlparse(path_or_url).scheme in {"http", "https"}:
        with urlopen(path_or_url) as response:
            return response.read().decode("utf-8")
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


def build_bundle(config_path: Path, rkn_source: str | None, rkn_headers: str | None, rkn_format: str) -> dict:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    blocked_sites = load_blocked_sites(config, rkn_source=rkn_source, rkn_headers=rkn_headers, rkn_format=rkn_format)
    dictionary = []
    exceptions = []

    for item in config.get("dictionary", []):
        data = read_json_source(item["path"])
        dictionary.extend(data)

    for item in config.get("exceptions", []):
        entries = [
            line.strip().lower()
            for line in read_text_source(item["path"]).splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        exceptions.extend(entries)

    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "version": timestamp.replace(":", "").replace("-", ""),
        "updatedAt": timestamp,
        "metadata": {
            "sourceLabel": "generated-by-updater",
            "checkedAt": timestamp,
            "notes": "Bundle сформирован локальным скриптом и готов к публикации в GitHub Raw."
        },
        "blockedSites": blocked_sites,
        "dictionary": dictionary,
        "exceptions": sorted(set(exceptions))
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
