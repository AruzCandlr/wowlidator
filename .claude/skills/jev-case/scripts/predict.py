#!/usr/bin/env python3
"""Predict what a jev-case run will trip over, before a browser is spent.

    predict.py --flow <flow.json> --catalog <row.csv> --row 1.001 --fieldmap <json> [--db-url-env WOWLIDATOR_DB_URL]

The lint (`check_flow.py`) judges the flow's shape. This judges the flow against
the WORLD it will run in: the route it opens, the masters its values must exist
in, the application's own conditional requirements, and the parts of the sheet
nobody can perform in a browser. Every rule here is a fault that has already cost
a real run or that the application's source makes certain. Output is one line
per prediction, `LEVEL code: text`; exit 2 when a BLOCKER is predicted.

Levels: BLOCKER — the run cannot reach Submit · RISK — likely to fail a step ·
GAP — the sheet asks for something this run will not prove · INFO.
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from author import read_row, pairs_of, norm, flat, expected_lines, steps_of  # noqa: E402

OUT: list[tuple[str, str, str]] = []
def say(level: str, code: str, text: str) -> None: OUT.append((level, code, text))

def sql(url: str | None, q: str) -> list[list[str]] | None:
    if not url: return None
    try:
        r = subprocess.run(["psql", url, "-At", "-F", "\t", "-c", q], capture_output=True, text=True, timeout=25)
    except Exception:
        return None
    if r.returncode != 0: return None
    return [ln.split("\t") for ln in r.stdout.splitlines() if ln.strip()]

def code_of(v: str) -> str:
    m = re.match(r"\s*([A-Za-z0-9_.:-]+)", v or "")
    return m.group(1) if m else ""

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flow", required=True, type=Path)
    ap.add_argument("--catalog", required=True, type=Path)
    ap.add_argument("--row", default="")
    ap.add_argument("--fieldmap", required=True, type=Path)
    ap.add_argument("--db-url-env", default="WOWLIDATOR_DB_URL")
    a = ap.parse_args()
    url = os.environ.get(a.db_url_env)

    flow = json.loads(a.flow.read_text(encoding="utf-8"))
    fmap = json.loads(a.fieldmap.read_text(encoding="utf-8"))
    row, _ = read_row(a.catalog, a.row)
    steps = flat(flow["steps"]); setup = flow.get("setup", [])
    fields = {norm(k): v for k, v in (fmap.get("fields") or {}).items()}
    by_sel = {}
    for nk, f in fields.items(): by_sel.setdefault(f.get("selector"), nk)
    entered = {by_sel[x["selector"]]: x.get("value", "") for x in steps
               if x["action"] in ("fill", "selectOption") and x.get("selector") in by_sel}
    tdata = row.get(" Test Data", row.get("Test Data", "")); tsteps = row.get("Test Step", "")
    pre = row.get("Preconditions", ""); exp = row.get(" Expected result", row.get("Expected result", ""))

    # -- 1. the route ---------------------------------------------------------
    login = (fmap.get("route") or {}).get("login", "/login")
    if not any(x["action"] == "goto" and not str(x.get("url", "")).endswith(login) for x in setup + steps):
        say("BLOCKER", "no-route", "the flow never opens the form: no menu was read from the sheet, so every field "
            "step would run against the landing page")
    entry = re.search(r"Entry Route\s*[:=]\s*(\w+)", pre + "\n" + tdata, re.I)
    if entry and entry.group(1).lower() != "keyin":
        say("BLOCKER" if not any("tab=" in str(x.get("url", "")) for x in setup + steps) else "RISK", "entry-route",
            f"Entry Route = {entry.group(1)}: the record must arrive from another system first (a pending recruit / "
            f"a file). The key-in field map cannot create that precondition; without it the form this flow fills is "
            f"the wrong form")

    # -- 2. the sheet says it cannot run, or hands work to people -------------
    for pat, why in ((r"ยังรันไม่ได้|ยังไม่สามารถรัน|cannot be run", "the sheet itself says this case cannot run yet"),
                     (r"ต้องได้สิทธิ์|ขอสิทธิ์|permission (is )?required", "needs an access right the test account may not hold"),
                     (r"รอรอบ|batch|08:00|ข้ามวัน|next day", "depends on a scheduled job or a later day"),
                     (r"แจ้งผู้ดูแล|ขอให้ทีม|ทีมเตรียมข้อมูล", "a step is carried out by another team")):
        m = re.search(pat, "\n".join([pre, tdata, tsteps, exp]), re.I)
        if m: say("GAP", "out-of-band", f"{why} (“{m.group(0)}”)")

    # -- 3. modules a browser on EC cannot see ---------------------------------
    mods = {e["mod"] for e in expected_lines(exp)}
    other = sorted(m for m in mods if m and not m.upper().startswith("EC"))
    if other:
        n = sum(1 for e in expected_lines(exp) if e["mod"] in other)
        say("GAP", "other-modules", f"{n} Expected line(s) belong to {', '.join(other)}; this run drives EC only, so "
            f"they end NOT_REACHED whatever happens")
    pend = [e for e in expected_lines(exp) if re.search(r"=\s*\?|\bOQ-|\bTBC\b", e["text"])]
    if pend: say("INFO", "open-questions", f"{len(pend)} Expected line(s) have no answer in the sheet (OQ / ?) — PENDING_QA")

    # -- 4. the application's conditional requirements (humi-SIT source) --------
    grp = code_of(entered.get("employee group", ""))
    if grp == "F" or re.search(r"DVT", entered.get("employee group", ""), re.I):
        say("BLOCKER", "dvt-fields", "Employee Group F/DVT makes seven more fields required (project, university, type, "
            "degree, course, course of time, academic year); none is in the field map")
    if grp and grp not in "ABC" and "contract type" not in entered:
        say("BLOCKER", "contract-type", f"group {grp} gets no Contract Type from the app and the flow sets none")
    if grp == "D" and "contract end date" not in entered:
        say("BLOCKER", "contract-end", "group D keeps Contract End Date required and the flow sets none")
    nat = entered.get("nationality", "")
    if nat and not re.search(r"^\s*(thai|th)\b", nat, re.I):
        say("BLOCKER", "work-permit", f"Nationality {nat!r} is foreign: Work Permit type, country, number and issue date "
            f"become required; none is in the field map")
    hire = next((x.get("value") for x in steps if x.get("selector") == (fields.get("hire date") or {}).get("selector")
                 and x["action"] == "fill"), None)
    if not hire: say("BLOCKER", "hire-date", "no Hire Date is entered; Identity cannot validate")
    for need in ("company", "event reason", "house no", "province", "district", "sub-district", "employee group", "employee sub group", "supervisor id", "original start date", "seniority date",
                 "time status", "work schedule", "holiday calendar", "amount", "pay group", "bank", "account number",
                 "payment method", "position"):
        if need not in entered and not (need == "employee sub group" and "employee subgroup" in entered):
            say("BLOCKER", "required-missing", f"the app requires {need!r} and no step enters it")

    # -- 5. values against the masters ---------------------------------------
    def exists(label: str, q: str, value: str) -> None:
        if not value: return
        r = sql(url, q)
        if r is None: say("INFO", "db-unchecked", f"{label} {value!r} not checked (no DB)"); return
        if not r: say("BLOCKER", "not-in-master", f"{label} {value!r} is not in the SIT master — its list will never offer it")
    esc = lambda v: v.replace("'", "''")
    pos = code_of(entered.get("position", "")); comp = code_of(entered.get("company", ""))
    if pos:
        r = sql(url, f"select company_code from employee_foundation.positions where position_code='{esc(pos)}'")
        if r is not None and not r: say("BLOCKER", "not-in-master", f"Position {pos} does not exist in SIT")
        elif r and comp and r[0][0] and r[0][0] != comp:
            say("BLOCKER", "position-company", f"Position {pos} belongs to company {r[0][0]}, the flow enters {comp}: the "
                f"position search is scoped to the company and will return nothing")
        taken = sql(url, f"select count(*) from employee_center.employment_jobs where position_code='{esc(pos)}' and employee_status ilike 'A%'")
        if taken and taken[0][0].isdigit() and int(taken[0][0]) > 0:
            say("RISK", "position-occupied", f"Position {pos} already holds {taken[0][0]} active employee(s); if the app "
                f"enforces vacancy the submit is refused")
    sub = code_of(entered.get("employee sub group", entered.get("employee subgroup", "")))
    if grp and sub:
        exists(f"Sub-Group for group {grp}", f"select 1 from employee_foundation.view_employee_group_mappings where "
               f"employee_group_code='{esc(grp)}' and employee_subgroup_code='{esc(sub)}'", sub)
    ws = code_of(entered.get("work schedule", ""))
    if ws: exists("Work Schedule", f"select 1 from time_management.work_schedule where work_schedule_code='{esc(ws)}'", ws)
    hc = code_of(entered.get("holiday calendar", ""))
    if hc: exists("Holiday Calendar", f"select 1 from time_management.holiday_calendar where holiday_calendar_code='{esc(hc)}'", hc)
    sup = code_of(entered.get("supervisor id", ""))
    if sup: exists("Supervisor", f"select 1 from employee_center.employment_jobs where employee_id='{esc(sup)}' and employee_status ilike 'A%'", sup)
    nid = re.sub(r"\D", "", entered.get("national id", entered.get("national id / tax id", "")))
    if nid:
        r = sql(url, f"select count(*) from employee_center.person_national_ids where replace(national_id,'-','')='{nid}'")
        if r and r[0][0].isdigit() and int(r[0][0]) > 0:
            say("RISK", "duplicate-id", f"National ID {nid} is already on {r[0][0]} person record(s); a duplicate check "
                f"would refuse the submit or turn it into a rehire")

    # -- 6. what the flow leaves to the agent, and what it dropped ------------
    legs = [x for x in steps if x["action"] == "workflow"]
    if len(legs) > 4: say("RISK", "agent-heavy", f"{len(legs)} agent legs; each is a place the run can stall")
    summ = a.flow.with_name("author.log")
    if summ.exists():
        n = summ.read_text(encoding="utf-8").count("NOT PERFORMED")
        if n: say("GAP", "unperformed", f"{n} sheet instruction(s) are not performed (see author.log)")
    unverified = sorted({by_sel[x["selector"]] for x in steps if x.get("selector") in by_sel
                         and "unverified" in str(fields[by_sel[x["selector"]]].get("$note", "")).lower()})
    if unverified: say("RISK", "unverified-selectors", "selectors never yet seen live: " + ", ".join(unverified))

    order = {"BLOCKER": 0, "RISK": 1, "GAP": 2, "INFO": 3}
    for lvl, code, text in sorted(OUT, key=lambda t: order[t[0]]): print(f"{lvl} {code}: {text}")
    print(f"{sum(1 for o in OUT if o[0]=='BLOCKER')} blocker(s) · {sum(1 for o in OUT if o[0]=='RISK')} risk(s) · "
          f"{sum(1 for o in OUT if o[0]=='GAP')} gap(s)")
    raise SystemExit(2 if any(o[0] == "BLOCKER" for o in OUT) else 0)

if __name__ == "__main__":
    main()
