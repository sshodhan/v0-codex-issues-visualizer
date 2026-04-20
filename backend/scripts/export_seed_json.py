"""Export the canonical seed_data.py constants to scripts/003_seed_data.json.

Run from repo root:
    python -m backend.scripts.export_seed_json
"""

from __future__ import annotations

import json
from pathlib import Path

from backend.app import seed_data


def main() -> None:
    out_dir = Path(__file__).resolve().parents[2] / "scripts"
    out_path = out_dir / "003_seed_data.json"
    payload = {
        "categories": seed_data.CATEGORIES,
        "user_segments": seed_data.USER_SEGMENTS,
        "root_causes": seed_data.ROOT_CAUSES,
        "competitive_data": seed_data.COMPETITIVE_DATA,
        "issues": seed_data.ISSUES,
        "timeline": seed_data.TIMELINE,
        "category_timeseries": seed_data.CATEGORY_TIMESERIES,
    }
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
