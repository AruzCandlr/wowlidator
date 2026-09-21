#!/usr/bin/env python3
"""Judge an authored flow against the sheet it came from, without a browser.

A browser run costs minutes and a shared environment's data; these are the
faults that made previous runs useless, and every one of them is visible in the
JSON alone. Exit 1 on any failure.

    check_flow.py --flow <flow.json> --catalog <csv> --row 1.001 --fieldmap <json>
"""
from __future__ import annotations
import argparse, csv, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from author import read_row, steps_of, pairs_of, norm, derived_keys, flat, not_enterable, LOGIN_STEP, SUBMIT_WORD  # noqa: E402

FAILS: list[str] = []
WARNS: list[str] = []
def bad(m: str) -> None: FAILS.append(m)
def warn(m: str) -> None: WARNS.append(m)

def step_no(s: dict) -> int | None:
    m = re.search(r"Step (\d+)", s.get("goal", "") or s.get("intent", "") or "")
    return int(m.group(1)) if m else None

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flow", required=True, type=Path)
    ap.add_argument("--catalog", required=True, type=Path)
    ap.add_argument("--row", default="")
    ap.add_argument("--fieldmap", required=True, type=Path)
    a = ap.parse_args()

    flow = json.loads(a.flow.read_text(encoding="utf-8"))
    row, _ = read_row(a.catalog, a.row)
    fmap = json.loads(a.fieldmap.read_text(encoding="utf-8"))
    fields = {norm(k): v for k, v in (fmap.get("fields") or {}).items()}
    steps = flat(flow["steps"])      # branches inlined: nesting hides nothing
    sheet = [s for s in steps_of(row.get("Test Step", "")) if not LOGIN_STEP.match(s["title"])]
    known = ({norm(k) for k in (fmap.get("fields") or {})}
             | {norm(x) for x in (fmap.get("$agentOnly", {}).get("fields") or [])}
             | {norm(x) for x in (fmap.get("$otherKeys") or [])}
             | {norm(x) for sec in (fmap.get("$sections") or {}).values() for x in sec})
    pairs = {norm(k): v for k, v in pairs_of(row.get(" Test Data", row.get("Test Data", "")), known)}

    # 1. The flow performs the sheet's steps in the sheet's order.
    seen = [n for n in (step_no(s) for s in steps) if n is not None]
    if seen != sorted(seen):
        bad(f"steps run out of the sheet's order: {seen}")

    # 2. Every leg carries concrete work. A goal with no value and no
    #    verb the page can act on is what made the agent answer BLOCKED.
    for i, s in enumerate(steps):
        if s["action"] != "workflow": continue
        g = s.get("goal", "")
        has_value = " = " in g or "set " in g
        has_instruction = re.search(r"เลือก|กรอก|กด|คีย์|submit|ยื่น|เปลี่ยน|ค้นหา|เปิด|open|click|enter|search|change|select|fill|set", g, re.I)
        if not has_value and not has_instruction:
            bad(f"leg [{i}] has no concrete work: {g[:110]!r}")
        if re.search(r"ตาม Test Data\s*\(", g):
            bad(f"leg [{i}] defers to the sheet instead of naming values: {g[:110]!r}")
        # A constraint handed over as a literal is a value the agent must refuse.
        for m in re.finditer(r'"([^"]+)"\s*=\s*"([^"]*)"', g):
            if re.search(r"[<>≤≥]|น้อยกว่า|มากกว่า|less than|greater than", m.group(2)):
                bad(f"leg [{i}] asks to type the constraint {m.group(2)!r} as a value")

    # 3a. A leg that says to choose something, with no value named, must carry a
    #     script. The harness stops such a leg rather than guess, so without one
    #     it can never succeed.
    for i, s_ in enumerate(steps):
        if s_["action"] != "workflow": continue
        g = s_.get("goal", "")
        if not re.search(r"เลือก|choose|select", g, re.I): continue
        if " = " in g or s_.get("script"): continue
        bad(f"leg [{i}] says choose but names no value and carries no script: {g[:100]!r}")

    # 2b. No leg carries more than two fields: four in one leg answered BLOCKED
    #     at p=0.35 on every run that reached page 2 (jev8–jev14).
    for i, s_ in enumerate(steps):
        if s_["action"] != "workflow": continue
        n = len(re.findall(r'"[^"]+"\s*=\s*"', s_.get("goal", "")))
        if n > 2:
            bad(f"leg [{i}] carries {n} fields; the agent is asked one or two at a time")

    # 3. Nothing acts after the submit.
    sub = next((i for i, s in enumerate(steps)
                if s["action"] == "workflow" and SUBMIT_WORD.search(s.get("goal", ""))), None)
    if sub is not None:
        for i, s in enumerate(steps[sub + 1:], sub + 1):
            if s["action"] in ("fill", "selectOption") or \
               (s["action"] == "workflow" and " = " in s.get("goal", "")):
                bad(f"[{i}] {s['action']} enters data after the submit at [{sub}]")

    # 4. A page-2 control is never touched before the Next click.
    step2 = {norm(x) for x in (fmap.get("$notOnStep1", {}).get("fields") or [])}
    sel2 = {fields[nk]["selector"] for nk in step2 if nk in fields}
    nxt = (fmap.get("controls") or {}).get("next")
    nx = next((i for i, s in enumerate(steps) if s.get("selector") == nxt), None)
    for i, s in enumerate(steps):
        if s.get("selector") in sel2 and s["action"] in ("fill", "selectOption"):
            if nx is None or i < nx:
                bad(f"[{i}] touches a page-2 control before the Next click")

    # 4a. A page-1 control is never entered after the Next click: it is typed at
    #     a page that no longer shows it, while page 1 is refused for lacking it
    #     (Company on 1.030/1.061/1.068, Event Reason on 1.013 — 2026-09-21).
    sel1 = {f["selector"] for nk, f in fields.items() if nk not in step2 and f.get("selector")} - sel2
    if nx is not None:
        for i, s in enumerate(steps[nx + 1:], nx + 1):
            if s.get("selector") in sel1 and s["action"] in ("fill", "selectOption"):
                bad(f"[{i}] enters the page-1 control {s['selector']} after the Next click at [{nx}]")

    # 4b. A leg naming page-1 controls must not run after the Next click.
    page1_labels = [k for k in (fmap.get("$requiredViaAgent") or {}) if not k.startswith("$")]
    if nx is not None:
        for i, s_ in enumerate(steps[nx + 1:], nx + 1):
            if s_["action"] != "workflow": continue
            hit = [l for l in page1_labels if l in s_.get("goal", "")]
            if hit:
                bad(f"leg [{i}] sets page-1 field(s) {hit} after the Next click at [{nx}]")

    # 4c. Identity must be complete before the Address section is touched: the
    #     form reveals Address only then.
    sections_ = {k: {norm(x) for x in v} for k, v in (fmap.get("$sections") or {}).items()}
    addr_sel = {fields[nk]["selector"] for nk in sections_.get("address", set())
                if nk in fields and fields[nk].get("action") != "fill"}
    first_addr = next((i for i, s_ in enumerate(steps) if s_.get("selector") in addr_sel), None)
    req_leg = next((i for i, s_ in enumerate(steps)
                    if s_["action"] == "workflow" and "requires that the case" in s_.get("goal", "")), None)
    if first_addr is not None and req_leg is not None and req_leg > first_addr:
        bad(f"the required-identity leg [{req_leg}] runs after the first address step [{first_addr}]")

    # 4d. Every advance press is preceded by proof its page is filled and
    #     followed by proof the page actually moved. A press that succeeds
    #     mechanically is not an advance: the application may answer with a
    #     validation dialog and stay where it was, and the flow then types the
    #     next page's data into the old one (observed 2026-09-21, step 35).
    adv = fmap.get("$advance") or {}
    ctrls = {(fmap.get("controls") or {}).get(k) for k in adv.get("controls", [])}
    ctrls.discard(None)
    for i, s_ in enumerate(steps):
        if s_["action"] != "click" or s_.get("selector") not in ctrls: continue
        if not any(x["action"] in ("expectValue", "expectVisible") for x in steps[:i]):
            bad(f"advance press [{i}] is not preceded by any check that its page is filled")
        if not any(x["action"] == "expectHidden" for x in steps[i + 1:i + 4]):
            bad(f"advance press [{i}] is not followed by proof the page moved: "
                f"no expectHidden on the error dialog or the old page marker")

    # 0. Every action must be one the engine actually dispatches. An invented
    #    action is dropped by the flow parser silently — `expectFilled` looked
    #    like a verification step, was authored seven times, and never ran once.
    engine = set(fmap.get("$engineActions") or [])
    if engine:
        for i, s_ in enumerate(steps + flow.get("setup", [])):
            if s_["action"] not in engine:
                bad(f"[{i}] action {s_['action']!r} is not one the engine dispatches — "
                    f"the parser will drop this step without a word")

    # 5. Every Test Data pair the field map knows is placed somewhere — except
    # a value the Expected output says the application fills, which is never
    # typed (the author's `derived_keys`, shared so the two cannot disagree).
    raw_pairs = pairs_of(row.get(" Test Data", row.get("Test Data", "")), known)
    derived = derived_keys({norm(k): k for k, _ in raw_pairs}, row.get(" Expected result", row.get("Expected result", "")))
    placed = " ".join(json.dumps(s, ensure_ascii=False) for s in steps)
    aside = not_enterable({norm(k): (k, v) for k, v in raw_pairs}, fmap)   # an instruction after `=` is not data
    for nk, v in pairs.items():
        if nk not in fields or nk in derived or nk in aside: continue
        if fields[nk].get("action") == "read": continue
        alias = (fields[nk].get("values") or {}).get(v, v)
        if v not in placed and alias not in placed and nk not in placed.lower():
            bad(f"test data {nk!r} = {v!r} is in no step")

    # 6. A value the page cannot render must not be typed.
    for i, s in enumerate(steps):
        if s["action"] != "selectOption": continue
        for nk, f in fields.items():
            if f.get("selector") != s.get("selector"): continue
            alias = f.get("values") or {}
            if s.get("value") in alias:
                bad(f"[{i}] sends {s['value']!r}, but the page renders {alias[s['value']]!r}")

    # 7. An assertion must not be vacuous.
    for i, s in enumerate(steps):
        if s["action"] == "expectText":
            v = (s.get("value") or "").strip()
            if len(v) < 3 or v.lower() in {"no", "yes", "active", "0", "1"}:
                bad(f"[{i}] asserts the generic text {v!r}")
            if re.search(r"ตาม|ระบบ|ต้อง", v):
                bad(f"[{i}] asserts a Thai instruction as page text: {v[:60]!r}")

    # 8. The sheet's acting steps each left a trace.
    for st in sheet:
        body = " ".join([st["title"]] + st["bullets"])
        if not re.search(r"กรอก|เลือก|กด|คีย์|submit|ยื่น|เปลี่ยน", body, re.I): continue
        if st["n"] not in seen:
            warn(f"sheet step {st['n']} ({st['title'][:50]}) has no step in the flow")

    for w in WARNS: print(f"WARN: {w}")
    for f in FAILS: print(f"FAIL: {f}", file=sys.stderr)
    print(f"{len(steps)} steps · {len(FAILS)} failure(s) · {len(WARNS)} warning(s)")
    raise SystemExit(1 if FAILS else 0)

if __name__ == "__main__":
    main()
