from __future__ import annotations

import argparse
import json
from pathlib import Path

from rkn_registry import load_rkn_entries


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Парсер официальной выгрузки РКН. Поддерживает XML/CSV/JSON/TXT, а также ZIP/GZ-архивы. "
            "Источник может быть локальным файлом или URL официальной выгрузки."
        )
    )
    parser.add_argument("--source", required=True, help="Путь к выгрузке РКН или URL выгрузки")
    parser.add_argument("--output", required=True, help="Куда сохранить JSON со списком blockedSites")
    parser.add_argument("--format", default="auto", help="Формат входных данных: auto, xml, csv, json, txt")
    parser.add_argument("--headers", default="", help="JSON-файл с заголовками для авторизованной загрузки")
    parser.add_argument("--source-label", default="rkn_registry", help="Текстовая метка источника")
    args = parser.parse_args()

    entries = load_rkn_entries(
        source=args.source,
        source_label=args.source_label,
        input_format=args.format,
        headers_path=args.headers or None
    )

    output_path = Path(args.output).resolve()
    output_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(entries)} entries to {output_path}")


if __name__ == "__main__":
    main()
