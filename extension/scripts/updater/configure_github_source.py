from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE_CONFIG_PATH = ROOT.parent.parent / "data" / "source-config.json"


def build_raw_url(owner: str, repo: str, branch: str, bundle_path: str) -> str:
    cleaned_path = bundle_path.strip("/").replace("\\", "/")
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{cleaned_path}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Настройка GitHub Raw как основного источника bundle-файла")
    parser.add_argument("--owner", required=True, help="Владелец GitHub-репозитория")
    parser.add_argument("--repo", required=True, help="Имя GitHub-репозитория")
    parser.add_argument("--branch", default="main", help="Ветка, где лежит bundle-файл")
    parser.add_argument("--bundle-path", default="extension/data/default-bundle.json", help="Путь до bundle-файла внутри репозитория")
    parser.add_argument("--output", default=str(SOURCE_CONFIG_PATH), help="Куда сохранить source-config.json")
    args = parser.parse_args()

    output_path = Path(args.output).resolve()
    configured_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    bundle_url = build_raw_url(args.owner, args.repo, args.branch, args.bundle_path)

    payload = {
        "bundleUrl": bundle_url,
        "sourceLabel": "github-source-config",
        "configuredAt": configured_at,
        "repo": {
            "owner": args.owner,
            "name": args.repo,
            "branch": args.branch,
            "bundlePath": args.bundle_path.replace("\\", "/")
        }
    }

    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Source config saved to {output_path}")
    print(bundle_url)


if __name__ == "__main__":
    main()
