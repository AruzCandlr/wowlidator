#!/usr/bin/env python3
"""Make one case's run folder and print the shell exports that point at it.

    eval "$(python3 .claude/skills/jev-case/scripts/newcase.py --name hrsit-1001 --case HR-SIT-E2E-V01-1-001)"

Everything the run and the report package produce lands inside one folder, so a
report rebuild elsewhere can never overwrite it and the package travels as one
directory. The probe name is minted here because both halves need it: the flow
types it into the form, the DB query looks for it.
"""
from __future__ import annotations
import argparse, os, re, shlex, sys, time
from pathlib import Path

def report_root() -> Path:
    """Where this checkout writes artifacts — .env wins over the in-repo default."""
    env = os.environ.get("WOWLIDATOR_REPORT_DIR")
    if not env:
        for line in (Path(".env").read_text(encoding="utf-8").splitlines()
                     if Path(".env").exists() else []):
            if line.startswith("WOWLIDATOR_REPORT_DIR="):
                env = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    return Path(os.path.expanduser(env)) if env else Path(".wowlidator/reports")

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="short slug for the run folder")
    ap.add_argument("--case", required=True, help="CASE-ID, uppercase hyphenated")
    ap.add_argument("--fresh", action="store_true", help="stamp a new folder even if one exists")
    ap.add_argument("--probe", help="use this probe name instead of minting one from the clock — parallel "
                                    "lanes start within the same second and would otherwise share a name")
    a = ap.parse_args()

    case = a.case.upper()
    if not re.fullmatch(r"[A-Z0-9]+(?:-[A-Z0-9]+)+", case):
        sys.exit(f"case id must be uppercase hyphen-separated: {case!r}")

    root = report_root() / "runs"
    existing = sorted(root.glob(f"{a.name}-*")) if root.exists() else []
    if existing and not a.fresh and any((d / "proofs").exists() for d in existing):
        run = existing[-1]
        print(f"reusing {run}", file=sys.stderr)
    else:
        run = root / f"{a.name}-{time.strftime('%Y%m%d-%H%M%S')}"
        print(f"new run folder {run}", file=sys.stderr)
    for sub in ("proofs", "grim"):
        (run / sub).mkdir(parents=True, exist_ok=True)

    probe_file = run / "grim" / "probe-name.txt"
    if probe_file.exists():
        probe = probe_file.read_text().strip()
    else:
        probe = a.probe or "Jev" + time.strftime("%y%m%d%H%M%S")
        probe_file.write_text(probe)

    q = shlex.quote
    for k, v in (
        ("WOW_CASE", case),
        ("WOW_RUN_DIR", str(run)),
        ("WOW_GRIM_DIR", str(run / "grim")),
        ("WOW_PROBE", probe),
        ("WOW_FLOW", str(run / f"{case}.flow.json")),
        ("WOW_RUN_LOG", str(run / "run.log")),
        ("WOWLIDATOR_REPORT_DIR", str(run)),
        ("WOWLIDATOR_PROOF_DIR", str(run / "proofs")),
    ):
        print(f"export {k}={q(v)}")

if __name__ == "__main__":
    main()
