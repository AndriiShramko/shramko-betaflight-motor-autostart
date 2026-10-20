"""Retention for the two append-only logs: drop report and lead lines older than N days (default 365,
the 12 months the privacy note promises). Diagnostics files and daily totals are pruned by server.py.

  docker exec sma-api python /app/trim.py            # on the hub (bash deploy/hub.sh '...')
  python api/trim.py --data-dir /path/to/data --days 365 --dry-run

Each file is rewritten whole (temporary file, fsync, rename). The API appends without knowing about
this script, so a line written during the moment it runs could be lost: run it at a quiet hour.
Prints what it kept and dropped.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path


def trim(path: Path, cutoff_ts: str, dry_run: bool = False) -> tuple[int, int]:
    """Keeps the lines whose "ts" is at or after cutoff_ts (and lines it cannot read: never guess)."""
    if not path.exists():
        return 0, 0
    lines = path.read_text(encoding="utf-8").splitlines()
    keep = []
    for line in lines:
        try:
            ts = json.loads(line).get("ts", "")
        except (ValueError, AttributeError):
            ts = ""
        if not ts or ts >= cutoff_ts:
            keep.append(line)
    if not dry_run and len(keep) != len(lines):
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8", newline="\n") as f:
            f.write("".join(x + "\n" for x in keep))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    return len(keep), len(lines) - len(keep)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", default=os.environ.get("SMA_DATA_DIR", os.environ.get("DATA_DIR", "/data")))
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - a.days * 86400))
    for name in ("reports.jsonl", "leads.jsonl"):
        kept, dropped = trim(Path(a.data_dir) / name, cutoff, a.dry_run)
        print(f"{name}: kept {kept}, {'would drop' if a.dry_run else 'dropped'} {dropped} (older than {cutoff})")


if __name__ == "__main__":
    main()
