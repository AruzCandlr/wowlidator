#!/usr/bin/env python3
"""Write one single-row catalog per requested row: header + that row.

    split_rows.py <catalog.csv> <out-dir> <row> [<row> ...]

A workbook sheet exported whole carries a title row above its header and a
million blank rows below; the author and the report builder both read a
two-line file far faster, and the report packages exactly the row it judged.
"""
import csv, sys
from pathlib import Path

cat, out, want = Path(sys.argv[1]), Path(sys.argv[2]), set(sys.argv[3:])
rows = list(csv.reader(open(cat, encoding="utf-8-sig")))
at = next((i for i, r in enumerate(rows[:20])
           if {c.strip() for c in r} & {"Test Step", "Scenario ID", "No."}), 0)
hdr = rows[at]
out.mkdir(parents=True, exist_ok=True)
found = set()
for r in rows[at + 1:]:
    if r and r[0].strip() in want:
        with open(out / f"{r[0].strip()}.csv", "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows([hdr, r])
        found.add(r[0].strip())
for m in sorted(want - found): print(f"not in catalog: {m}", file=sys.stderr)
print(f"{len(found)} of {len(want)} rows written to {out}")
