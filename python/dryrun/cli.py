from __future__ import annotations

import argparse
import json
from pathlib import Path

from .cassette import CassetteStore


def main() -> None:
    parser = argparse.ArgumentParser(prog="dry-run-py", description="Verify or inspect a dry-run v2 cassette")
    parser.add_argument("cassette")
    parser.add_argument("--print", action="store_true", dest="print_document")
    args = parser.parse_args()
    document = CassetteStore(Path(args.cassette)).load()
    if args.print_document:
        print(json.dumps(document, ensure_ascii=False, indent=2))
    else:
        print(f"valid dry-run cassette v{document['version']}: {len(document['interactions'])} interaction(s)")


if __name__ == "__main__":
    main()
