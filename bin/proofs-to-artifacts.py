#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["rich"]
# ///

"""
Turn wowlidator proof bundles into QA Command Center evidence runs.

    bin/proofs-to-artifacts.py                     # default roots
    bin/proofs-to-artifacts.py --proofs DIR --root DIR
    bin/proofs-to-artifacts.py --clean             # rebuild every run from scratch

wowlidator records each run as a proof bundle — one JSON per run, steps with
status, selector, resolution rung, error and an inline screenshot. The QA
Command Center reads a different shape: `<root>/artifacts/<run>/results.csv`,
ten fixed columns, screenshots as files on disk.

This converts one into the other. It is the only coupling between the two
systems, and it runs one way: wowlidator owns the run, the command center only
displays it. Nothing here re-judges a result — `passed`/`failed` map straight
onto PASS/FAIL, so the UI cannot disagree with the engine.

Verdict mapping, and why `skipped` is BLOCKED rather than FAIL: a step that
never ran proved nothing about the application, and scoring it as a failure
would report the harness's own gap as a defect in the product.
"""

import argparse
import base64
import csv
import json
import re
import shutil
import sys
from pathlib import Path

from rich.console import Console
from rich.table import Table

console = Console()

RESULT_HEADER = [
    "case_id",
    "step_no",
    "action",
    "test_data_used",
    "cmd_or_request",
    "expected",
    "actual",
    "verdict",
    "screenshot_path",
    "notes",
]

# The command center accepts exactly these; anything else makes it refuse the
# whole file with "unknown verdict".
VERDICT = {"passed": "PASS", "failed": "FAIL", "skipped": "BLOCKED"}


def slug(text: str, fallback: str = "run") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", (text or "").strip()).strip("-").lower()
    return cleaned[:60] or fallback


def describe_expected(step: dict) -> str:
    """What the step was there to prove, in the author's words where possible."""
    if intent := (step.get("intent") or "").strip():
        return intent
    action = step.get("action") or ""
    selector = step.get("selector") or step.get("url") or ""
    return f"{action} {selector}".strip()


def describe_actual(step: dict) -> str:
    if error := (step.get("error") or "").strip():
        return error
    detail = step.get("detail")
    if isinstance(detail, dict):
        for key in ("text", "value", "url", "count", "status"):
            if key in detail:
                return f"{key}={detail[key]}"
        return json.dumps(detail, ensure_ascii=False)[:200]
    return "ok" if step.get("status") == "passed" else ""


def describe_notes(step: dict, defects_by_index: dict[int, list[dict]]) -> str:
    parts: list[str] = []
    # The rung that resolved the selector is the drift signal: a climbing
    # `jit` count means the tests are drifting from the app.
    if rung := step.get("resolution"):
        parts.append(f"resolved:{rung}")
    if (duration := step.get("durationMs")) is not None:
        parts.append(f"{duration}ms")
    for defect in defects_by_index.get(step.get("index", -1), []):
        parts.append(f"{defect.get('severity', '?')}/{defect.get('category', '?')}: {defect.get('title', '')}")
    if failed := [c for c in (step.get("network") or []) if (c.get("status") or 0) >= 500]:
        parts.append(f"{len(failed)} backend call(s) 5xx")
    return " · ".join(parts)


def convert(bundle_path: Path, artifacts_root: Path) -> tuple[str, int, dict[str, int]] | None:
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        console.print(f"[yellow]![/yellow] skipping {bundle_path.name}: {exc}")
        return None

    steps = bundle.get("steps") or []
    if not steps:
        return None

    run_id = str(bundle.get("runId") or bundle_path.stem)
    case_id = slug(bundle.get("name") or "", fallback=run_id[:8])
    # Run directory carries the id so two runs of the same flow never collide.
    run_dir = artifacts_root / f"{case_id}-{run_id[:8]}"
    shots_dir = run_dir / "screenshots"
    run_dir.mkdir(parents=True, exist_ok=True)

    defects_by_index: dict[int, list[dict]] = {}
    for defect in bundle.get("defects") or []:
        index = defect.get("stepIndex")
        if isinstance(index, int):
            defects_by_index.setdefault(index, []).append(defect)

    counts: dict[str, int] = {}
    rows: list[list[str]] = []
    for step in steps:
        verdict = VERDICT.get(step.get("status", ""), "ORACLE_UNAVAILABLE")
        counts[verdict] = counts.get(verdict, 0) + 1

        screenshot_rel = ""
        raw = step.get("screenshot")
        if isinstance(raw, str) and raw:
            payload = raw.split(",", 1)[-1]  # tolerate a data: URI prefix
            try:
                shots_dir.mkdir(parents=True, exist_ok=True)
                name = f"step-{step.get('index', 0):03d}.png"
                (shots_dir / name).write_bytes(base64.b64decode(payload))
                # Relative to the command center's root, which is how it
                # rebases paths before serving them.
                screenshot_rel = str((run_dir / "screenshots" / name).relative_to(artifacts_root.parent))
            except (ValueError, OSError):
                screenshot_rel = ""

        rows.append([
            case_id,
            str(step.get("index", "")),
            step.get("action") or "",
            "",  # test_data_used — wowlidator carries data inside detail, not as a column
            step.get("resolvedSelector") or step.get("selector") or step.get("url") or "",
            describe_expected(step),
            describe_actual(step),
            verdict,
            screenshot_rel,
            describe_notes(step, defects_by_index),
        ])

    with (run_dir / "results.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(RESULT_HEADER)
        writer.writerows(rows)

    return run_dir.name, len(rows), counts


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Convert wowlidator proofs into QA Command Center runs.")
    parser.add_argument(
        "--proofs",
        type=Path,
        default=here.parent / "valst-output" / "proofs",
        help="directory of wowlidator proof bundles",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=here.parent / "valst-output",
        help="GRIM_VERIFIER_ROOT — runs are written to <root>/artifacts/",
    )
    parser.add_argument("--clean", action="store_true", help="remove existing artifacts first")
    args = parser.parse_args()

    if not args.proofs.is_dir():
        console.print(f"[red]✗[/red] no proof bundles at {args.proofs}")
        console.print("  [dim]run something first: grimval go <url>[/dim]")
        sys.exit(1)

    artifacts_root = args.root / "artifacts"
    if args.clean and artifacts_root.exists():
        shutil.rmtree(artifacts_root)
    artifacts_root.mkdir(parents=True, exist_ok=True)

    bundles = sorted(args.proofs.glob("*.json"))
    if not bundles:
        console.print(f"[yellow]![/yellow] {args.proofs} has no bundles yet")
        return

    table = Table(title=f"{args.root}/artifacts", border_style="cyan", title_justify="left")
    table.add_column("Run", style="cyan")
    table.add_column("Steps", justify="right")
    table.add_column("Verdicts", style="dim")

    converted = 0
    produced: set[str] = set()
    for bundle_path in bundles:
        result = convert(bundle_path, artifacts_root)
        if result is None:
            continue
        name, step_count, counts = result
        produced.add(name)
        summary = " ".join(f"{verdict}:{n}" for verdict, n in sorted(counts.items()))
        table.add_row(name, str(step_count), summary)
        converted += 1

    # Mirror the proof directory, do not accumulate against it.
    #
    # This only ever added. Delete a proof bundle and its evidence run stayed
    # behind for good, so the command center kept showing runs whose proof was
    # gone — and deleting the proofs and starting again brought all of them
    # back on the next launch, which is exactly the opposite of what deleting
    # them meant. A run here exists because a bundle exists; when the bundle
    # goes, so does the run.
    pruned = 0
    for existing in artifacts_root.iterdir():
        if not existing.is_dir() or existing.name in produced:
            continue
        shutil.rmtree(existing)
        pruned += 1

    console.print(table)
    console.print(f"[green]✓[/green] {converted} run(s) ready for the QA Command Center")
    if pruned:
        console.print(f"  [dim]pruned {pruned} run(s) whose proof bundle no longer exists[/dim]")


if __name__ == "__main__":
    main()
