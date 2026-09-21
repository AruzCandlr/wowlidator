#!/usr/bin/env python3
"""Write one runnable flow for one catalog row. No model call, ever.

The sheet is the only source. A Test Data pair whose control the field map
names becomes a deterministic step; a pair it does not name rides a workflow
leg, which is the one place Jev is asked anything. A numbered Test Step becomes
one leg carrying the pairs that step mentions. An Expected line becomes an
assertion only when the sheet states a value a page could show — otherwise it is
recorded as not covered rather than asserted vacuously.

    author.py --catalog <csv> --row 1.001 --fieldmap <json> --base-url <url>
              --out <flow.json> --probe <name> [--persona LABEL] [--json]

Prints a JSON summary to stdout with --json so the skill can read what it made.
"""
from __future__ import annotations
import argparse, csv, json, re, sys, unicodedata
from pathlib import Path

# ---------------------------------------------------------------- sheet reading
def norm(s: str) -> str:
    """Fold a sheet field name to a field-map key."""
    s = unicodedata.normalize("NFKC", s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s.strip(" :=-")

def read_row(catalog: Path, want: str) -> tuple[dict, list[str]]:
    rows = list(csv.reader(open(catalog, encoding="utf-8-sig")))
    if not rows: sys.exit(f"empty catalog: {catalog}")
    # A workbook sheet exported whole carries a title row (and sometimes a
    # merged sub-header) above the real header; the header is the first row
    # that names the columns a case is read from.
    at = next((i for i, r in enumerate(rows[:20])
               if {c.strip() for c in r} & {"Test Step", "Scenario ID", "No."}), 0)
    hdr = rows[at]
    idx: dict[str, int] = {}
    for i, h in enumerate(hdr):
        if h.strip() and h.strip() not in idx: idx[h.strip()] = i
    key = "No." if "No." in idx else hdr[0].strip()
    for r in rows[at + 1:]:
        if not any(c.strip() for c in r): continue
        val = r[idx.get(key, 0)].strip()
        sid = r[idx["Scenario ID"]].strip() if "Scenario ID" in idx else ""
        if want in ("", val, sid):
            return {h.strip(): (r[i] if i < len(r) else "") for h, i in idx.items()}, hdr
    sys.exit(f"row {want!r} not found in {catalog.name}")

# A sheet writes "- Key = Value" and sometimes "Key : Value".
PAIR = re.compile(r"^\s*[-•]?\s*(?P<k>[^=:\n]{2,60}?)\s*[=:]\s*(?P<v>.+?)\s*$")
# A Thai sheet's placeholders and non-values that must never be typed.
NOT_A_VALUE = re.compile(r"^(null|n/?a|-|\?|<[^>]+>|ตาม|เลือก|ยังไม่|ดูชีท)", re.I)

def pairs_of(text: str, known: set[str] | None = None) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for line in (text or "").splitlines():
        m = PAIR.match(line)
        if not m: continue
        k, v = m.group("k").strip(), m.group("v").strip()
        if not k or not v: continue
        if NOT_A_VALUE.match(v): continue
        # A packed line — "Department = 30042174 Branch = T153_1733" — ends this
        # value where the NEXT key begins. Find that key by testing the trailing
        # words before the next "=" against the keys we know, longest first.
        eq = re.search(r"\s*=", v)
        if eq and known:
            head = v[:eq.start()]
            words = head.split()
            for n in range(min(5, len(words)), 0, -1):
                if norm(" ".join(words[-n:])) in known:
                    head = " ".join(words[:-n]); break
            if head.strip(): v = head.strip()
        if not v or NOT_A_VALUE.match(v): continue
        if len(v) > 80: continue          # a sentence, not a value
        out.append((k, v))
    return out

STEP_HEAD = re.compile(r"^\s*(?P<n>\d{1,2})[.)]\s*(?P<t>.+?)\s*$")

def steps_of(text: str) -> list[dict]:
    """Numbered Test Step blocks: {n, title, bullets[]}."""
    steps: list[dict] = []
    cur: dict | None = None
    for line in (text or "").splitlines():
        m = STEP_HEAD.match(line)
        if m:
            cur = {"n": int(m.group("n")), "title": m.group("t").strip(), "bullets": []}
            steps.append(cur); continue
        s = line.strip().lstrip("-•").strip()
        if s and cur: cur["bullets"].append(s)
    return steps

def expected_lines(text: str) -> list[dict]:
    """Expected result lines with the module heading they sit under."""
    out, mod = [], ""
    for line in (text or "").splitlines():
        s = line.strip()
        if not s: continue
        if re.fullmatch(r"(EC|TM|BE|PY|Notification|Noti|Menu [^\n]{0,40})", s):
            mod = s; continue
        if s.startswith(("-", "•")):
            out.append({"mod": mod or "EC", "text": s.lstrip("-• ").strip()})
    return out

# ------------------------------------------------------------------- authoring
def date_iso(v: str) -> str | None:
    """`01 Sep 2027` / `2027-09-01` -> ISO. Anything else is not a date."""
    v = v.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v): return v
    rel = relative_date(v)
    if rel: return rel
    m = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})", v)
    if not m: return None
    months = {m_: i for i, m_ in enumerate(
        ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"], 1)}
    mo = months.get(m.group(2)[:3].lower())
    return f"{m.group(3)}-{mo:02d}-{int(m.group(1)):02d}" if mo else None

def relative_date(v: str) -> str | None:
    """`Today`, `< Today`, `Start of Month` — a sheet's relative date is one
    date on the day the run happens, resolved here so no leg is handed a phrase."""
    from datetime import date, timedelta
    t = date.today()
    w = re.sub(r"\s+", " ", v.strip().lower())
    m = re.fullmatch(r"(<|>|<=|>=|before|after|ก่อน|หลัง)?\s*(today|current date|test date|run date|วันนี้|วันที่ทดสอบ)", w)
    if m:
        op = m.group(1) or ""
        if op in ("<", "before", "ก่อน"): t -= timedelta(days=1)
        elif op in (">", "after", "หลัง"): t += timedelta(days=1)
        return t.isoformat()
    if re.fullmatch(r"(start|first day|beginning) of (the )?month|ต้นเดือน", w):
        return t.replace(day=1).isoformat()
    if re.fullmatch(r"(end|last day) of (the )?month|สิ้นเดือน", w):
        nxt = (t.replace(day=28) + timedelta(days=4)).replace(day=1)
        return (nxt - timedelta(days=1)).isoformat()
    m = re.search(r"(ย้อนหลัง|ก่อน|ล่วงหน้า|หลัง)[^\d]{0,30}(\d{1,3})\s*วัน|(\d{1,3})\s*days?\s*(before|ago|after|ahead)", w)
    if m:
        n = int(m.group(2) or m.group(3)); back = (m.group(1) in ("ย้อนหลัง", "ก่อน")) or (m.group(4) in ("before", "ago"))
        return (t - timedelta(days=n) if back else t + timedelta(days=n)).isoformat()
    if re.search(r"วันในอนาคต|future date|a future day", w):
        return (t + timedelta(days=30)).isoformat()
    if re.search(r"วันในอดีต|past date", w):
        return (t - timedelta(days=30)).isoformat()
    m = re.search(r"(?:วันที่\s*)?(\d{1,2})\s*(?:ของเดือนปัจจุบัน|of (?:the )?current month)", w)
    if m and 1 <= int(m.group(1)) <= 28:
        return t.replace(day=int(m.group(1))).isoformat()
    if re.search(r"(?:01/01|1\s*มกราคม|1 jan(uary)?)\s*(?:ของ)?\s*(?:ปีก่อนหน้า|ปีที่แล้ว|(?:of )?(?:the )?previous year|last year)", w):
        return t.replace(year=t.year - 1, month=1, day=1).isoformat()
    return None

CONSTRAINT = re.compile(r"[<>≤≥]|น้อยกว่า|มากกว่า|ไม่เกิน|อย่างน้อย|ระหว่าง|between|less than|greater than|older|younger")

def clause_for(key: str, value: str) -> str:
    """How a leg should ask for one pair: a literal is set, a constraint is
    satisfied."""
    if CONSTRAINT.search(value):
        return f'choose "{key}" so that {value}'
    return f'"{key}" = "{value}"'

def phrase(parts: list[str]) -> str:
    """`set a = b, c = d` for literals; instructions are appended as they read."""
    if not parts: return ""
    sets = [p for p in parts if p.startswith('"')]
    tells = [p for p in parts if not p.startswith('"')]
    out = ""
    if sets: out += " — set " + ", ".join(sets)
    if tells: out += (" — " if not sets else ", and ") + ", ".join(tells)
    return out

UI_VERB = re.compile(r"เลือก|กรอก|กด|คีย์|submit|ยื่น|เปลี่ยน|ค้นหา|เปิด|open|click|enter|search|change|select|fill|set", re.I)
# Work the sheet gives to a person, a batch job or another test case.
OUT_OF_BAND = re.compile(r"แจ้งผู้ดูแล|ขอให้ทีม|รอรอบ|อ้างอิง\s*TC|ขั้นตอนคืนค่า|คืนค่าเดิม|เปรียบเทียบผล|ห้ามแก้|ห้ามคีย์", re.I)

AGE_RULE = re.compile(r"(?:age|อายุ)\s*(<=|>=|<|>|=|น้อยกว่า|มากกว่า|ไม่เกิน|ครบ)?\s*(\d{1,2})", re.I)

def resolve_age(value: str, reference: str | None) -> str | None:
    """`Age < 60` against a hire date is one date, not a judgement call. The
    agent stalls on the picker when it is handed the phrase; it is resolved
    here so a deterministic rung can drive it."""
    m = AGE_RULE.search(value)
    if not m: return None
    if not reference:                 # no hire date stated: age is as of the run
        from datetime import date
        reference = date.today().isoformat()
    op, n = (m.group(1) or "<"), int(m.group(2))
    try:
        y, mo, d = (int(x) for x in reference.split("-"))
    except ValueError:
        return None
    if op in ("=", "ครบ"):                 # exactly n on the reference day
        return f"{y - n:04d}-{mo:02d}-{min(d, 28):02d}"
    if op in ("<", "<=", "น้อยกว่า", "ไม่เกิน"):
        born = y - (n - 1)          # comfortably under the bound
        mo = max(1, mo - 6) if mo > 6 else mo + 6
        if mo > 6 and y - (n - 1) == born and (m.group(1) or "<") in ("<", "น้อยกว่า"):
            born = y - (n - 1)
    else:
        born = y - (n + 1)
    return f"{born:04d}-{mo:02d}-{d:02d}"

# Measured across runs jev8–jev14: a leg carrying one or two fields succeeds; a
# leg carrying four or five answers BLOCKED or stalls. The agent is asked for
# one thing at a time.
LEG_FIELD_MAX = 2

def displayed(field: dict, typed: str) -> str:
    """What the page shows for a value that was typed. A control may reformat
    what it is given — an ID gains dashes, a date changes shape — and a check
    reads what is shown, so the comparison must be against that. The field map
    declares the shape per control (`mask`: '#' takes the next typed character,
    anything else is literal); with none declared the typed value stands."""
    mask = field.get("mask")
    if not mask: return typed
    chars = [c for c in typed if c.isalnum()]
    out = []
    for m in mask:
        if m == "#":
            if not chars: break
            out.append(chars.pop(0))
        else:
            out.append(m)
    return "".join(out) if not chars else typed

def persona_of(pre: str, fallback: str | None) -> str:
    m = re.search(r"<([A-Z_]+ACCOUNT)>", pre or "")
    return m.group(1) if m else (fallback or "HR_ADMIN_ACCOUNT")

def not_enterable(by_key: dict, fmap: dict) -> set[str]:
    """Stated pairs whose "value" no control can take: an instruction written
    after the `=`, an overlong sentence, a date phrase that resolves to nothing.
    Shared with the lint, so the two cannot disagree about what must be placed."""
    fields0 = {norm(k): v for k, v in (fmap.get("fields") or {}).items()}
    hd = by_key.get("hire date")
    ref = date_iso(hd[1]) if hd else None
    out = set()
    for nk, (_, v) in by_key.items():
        f = fields0.get(nk) or {}
        if not f: continue
        instruction = bool(re.search(r"กรอก|อย่างน้อย|เช่น|หลายรายการ|ดูชีท", v)) and not f.get("codeOnly")
        bad_date = f.get("kind") == "date" and not (date_iso(v) or resolve_age(v, ref))
        if (instruction and f.get("action") == "selectOption") or bad_date or len(v) > 80: out.add(nk)
    return out

def menu_route(pre: str, fmap: dict, tsteps: str = "") -> str | None:
    """Where the form lives. A sheet names its menu under `Menu :` in the
    Preconditions, or only in its first step ("ไปที่เมนู EC > New Hire (Manual
    Key-in)"), or not at all beyond `Entry Route : Keyin`. Eight of 25 rows gave
    no `Menu :` line, got no goto, and would have typed the whole form into the
    landing page."""
    menus = (fmap.get("route", {}).get("menu") or {})
    m = re.search(r"Menu\s*[:：]\s*(.+)", pre or "")
    texts = [m.group(1)] if m else []
    texts += [ln for ln in (tsteps or "").splitlines()[:6] if re.search(r"ไปที่|เมนู|menu|go to|open", ln, re.I)]
    for want in texts:
        for label, route in sorted(menus.items(), key=lambda kv: -len(kv[0])):
            if label.lower() in want.lower(): return route
    entry = re.search(r"Entry Route\s*[:=]\s*(\w+)", pre or "", re.I)
    if entry: return (fmap.get("route", {}).get("entry") or {}).get(entry.group(1).lower())
    return None

SECTION_WORDS = {
    "identity": r"identity|ตัวตน|ข้อมูลส่วนตัว|personal",
    "address": r"address|ที่อยู่",
    "position": r"position|organization|องค์กร|ตำแหน่ง",
    "compensation": r"compensation|payment|ค่าตอบแทน|การจ่าย",
}
LOGIN_STEP = re.compile(r"^\s*(login|เข้าสู่ระบบ)\b", re.I)
SUBMIT_WORD = re.compile(r"submit|กด\s*submit|บันทึกและส่ง", re.I)
VERIFY_ONLY = re.compile(r"^(ตรวจสอบ|verify|จด|บันทึก|record)", re.I)
CLEARS = re.compile(r"ถูกเคลียร์|เคลียร์|cleared|clear", re.I)
# Mirrors `authoring.derived` in src/generator/value-rules.ts — keep the two in step.
DERIVE_SOURCE = re.compile(r"(?:จาก|from)\s+[^\n]*?(?=ได้แก่|including|such as|:|$)", re.I)


def derived_keys(keys: dict[str, str], expected: str) -> set[str]:
    """The Test Data keys the Expected output says the APPLICATION fills —
    named on a line with a derive marker, after its "from <source>" clause is
    dropped (the source is the tester's input). One definition, read by the
    author to withhold them and by check_flow.py to accept their absence."""
    lines = [DERIVE_SOURCE.sub(" ", ln) for ln in expected.splitlines() if DERIVED.search(ln)]
    return {nk for nk, k in keys.items() if any(all(w in ln.lower() for w in k.lower().split()) for ln in lines)}
DERIVED = re.compile(r"auto-?derive|derive[sd]?|auto-?fill(ed)?|auto-?populated?|populated by the system|pulled from|"
                     r"pulls from|fetched from|computed|calculated|generated by the system|"
                     r"ดึงข้อมูล|ดึงค่า|ดึงมาจาก|ดึงจาก|คำนวณ|อัตโนมัติ", re.I)

def build(row: dict, fmap: dict, base_url: str, probe: str, persona_cli: str | None) -> dict:
    pre = row.get("Preconditions", "")
    tdata = row.get(" Test Data", row.get("Test Data", ""))
    tsteps = row.get("Test Step", "")
    exp = row.get(" Expected result", row.get("Expected result", ""))
    title = row.get("Titile", row.get("Title", "")) or row.get("Group", "")

    persona = persona_of(pre, persona_cli)
    fields = {norm(k): v for k, v in (fmap.get("fields") or {}).items()}
    agent_only = {norm(x) for x in (fmap.get("$agentOnly", {}).get("fields") or [])}
    step2 = {norm(x) for x in (fmap.get("$notOnStep1", {}).get("fields") or [])}
    sections = {k: {norm(x) for x in v} for k, v in (fmap.get("$sections") or {}).items()}
    login = (fmap.get("route", {}) or {}).get("login", "/login")
    route = menu_route(pre, fmap, row.get("Test Step", ""))

    setup = [
        {"action": "goto", "url": base_url + login},
        {"action": "signIn", "as": persona, "url": base_url + login,
         "intent": f"Preconditions: Login ด้วย <{persona}>"},
    ]
    if route:
        setup.append({"action": "goto", "url": base_url + route,
                      "intent": f"Preconditions: Menu {route}"})
    if fmap.get("opensOn"):
        setup.append({"action": "expectVisible", "selector": fmap["opensOn"],
                      "intent": "the form under test is open"})

    known_keys = ({norm(k) for k in (fmap.get("fields") or {})}
                  | {norm(x) for x in (fmap.get("$agentOnly", {}).get("fields") or [])}
                  | {norm(x) for x in (fmap.get("$otherKeys") or [])}
                  | {norm(x) for sec in (fmap.get("$sections") or {}).values() for x in sec})
    all_pairs = pairs_of(tdata, known_keys)
    by_key = {norm(k): (k, v) for k, v in all_pairs}
    # What the sheet writes after `=` is not always a value. "กรอกหลายรายการ อย่างน้อย
    # 3 บรรทัด เช่น …" was typed into the Pay Component search as if it were an
    # option (1.061, 2026-09-21), and a date phrase this author cannot resolve
    # left Date of Birth empty and page 1 refused (1.006). Such a pair is set
    # aside — the field map's `$required` default then enters the field — and the
    # sheet's wording is kept in the notes for the report.
    set_aside = [f"{k0} = {v0!r} is not a value a control can take — the field map's default is entered instead"
                 for nk0, (k0, v0) in by_key.items() if nk0 in not_enterable(by_key, fmap)]
    for nk0 in not_enterable(by_key, fmap): del by_key[nk0]
    # A value the sheet says the APPLICATION produces is never typed: an
    # Expected line with a derive marker names it (the TS author's rule,
    # `authoring.derived` in src/generator/value-rules.ts, mirrored here).
    # Live 2026-09-18: legs asked Jev to set "Employee Group" and "Work
    # Schedule", both pulled from the Position, and it BLOCKED on a field the
    # page fills itself — the cascade that left Submit unreachable.
    # The SOURCE a value is pulled from is not itself derived: in
    # "ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / …" Department is the
    # tester's input and Cost Center the app's. The clause "จาก/from <source>"
    # up to the list marker is dropped before the fields are matched.
    derived = derived_keys({nk: k for nk, (k, _) in by_key.items()}, exp)
    # The application's own validity rule outranks the sheet's prose: a field
    # the form refuses to advance without is an input, whatever an Expected
    # line says about where a like-named readout gets its value. HUMI's Identity
    # section requires Company on page 1 while the sheet lists Company among the
    # values "pulled from Position" — withholding it left the wizard refusing
    # Next with "Company" in its modal (2026-09-21).
    derived -= {norm(k) for k in (fmap.get("$required") or {})}
    # …and what the application renders read-only and fills itself is derived
    # even when the sheet's Expected never says so (declared per app, with the
    # evidence, in `$appDerived`).
    derived |= {norm(k) for k in ((fmap.get("$appDerived") or {}).get("fields") or [])} & set(by_key)
    used: set[str] = set()
    steps: list[dict] = []
    notes: list[str] = list(set_aside)
    state: dict = {"moved_on": False, "legs": 0}
    current: dict[str, str] = {}   # what each control holds right now
    _hd = by_key.get("hire date")
    state["hire_date"] = date_iso(_hd[1]) if _hd else None

    def rendered(nk: str, v: str) -> str:
        """The value the page actually shows. The sheet's Thai province is
        rendered in English, and a value no page shows can be matched by no
        rung — the 2026-09-18 run dead-ended clicking `text=กรุงเทพมหานคร`."""
        alias = (fields.get(nk) or {}).get("values") or {}
        return alias.get(v.strip(), v)

    def emit_pair(nk: str) -> bool:
        """Deterministic step for one pair, if a rung can drive it."""
        if nk in used or nk not in by_key: return False
        k, v = by_key[nk]
        f = fields.get(nk)
        if not f or f["action"] == "read" or f.get("readOnly"): return False
        if f["action"] == "openThenPick": pass
        if f.get("action") == "openThenPick":
            iso = date_iso(v) or resolve_age(v, state.get("hire_date"))
            if iso is None:
                notes.append(f"{k} = {v!r} is a phrase this author cannot resolve to a date")
                return False
            from datetime import date as _d
            y, mo, dd = (int(x) for x in iso.split("-"))
            shown = _d(y, mo, dd).strftime("%d %b %Y")
            # Open the calendar with a click — the one operation that resolves
            # on this control — then ask for the date inside the open picker.
            steps.append({"action": "click", "selector": f["selector"],
                          "intent": f"เปิดปฏิทินของ {k} ({v})"})
            leg(f'In the calendar that is now open for "{k}", navigate to '
                f'{_d(y, mo, dd).strftime("%B %Y")} and click day {dd}, so the field reads '
                f'"{shown}". The field may already hold another date; replace it.')
            current[nk] = shown
            used.add(nk)
            return True
        if f.get("viaAgent") or nk in agent_only:
            if f.get("kind") == "date":
                iso = date_iso(v) or resolve_age(v, state.get("hire_date"))
                if iso:
                    fmt = f.get("format")
                    shown = iso
                    if fmt:
                        from datetime import date as _d
                        y, mo, dd = (int(x) for x in iso.split("-"))
                        shown = _d(y, mo, dd).strftime(fmt)
                    leg(f'Step: set "{k}" to {shown} using its date picker — open it and pick that '
                        f'exact date (the field shows dates as "{shown}")')
                    current[nk] = shown
                    used.add(nk)
                    return True
            return False
        value = v
        if f.get("kind") == "date":
            iso = date_iso(v)
            if iso is None:
                iso = resolve_age(v, state.get("hire_date"))
                if iso is None:
                    notes.append(f"{k} = {v!r} is a phrase this author cannot resolve to a date")
                    return False
                notes.append(f"{k}: {v!r} against hire date {state['hire_date']} resolves to {iso}")
            fmt = f.get("format")
            if fmt:
                from datetime import date as _d
                y, mo, dd = (int(x) for x in iso.split("-"))
                value = _d(y, mo, dd).strftime(fmt)
                if value != iso: notes.append(f"{k}: typed as the page shows it — {value}")
            else:
                value = iso
            if f.get("display"):
                from datetime import date as _d
                y, mo, dd = (int(x) for x in iso.split("-"))
                shown = _d(y, mo, dd).strftime(f["display"])
                steps.append({"action": f["action"], "selector": f["selector"], "value": value,
                              "intent": f"Test data: {k} = {v}"})
                current[nk] = shown          # the page shows the display form
                used.add(nk)
                return True
        else:
            value = rendered(nk, v)
            if f.get("codeOnly") and code_of(value) != value:
                notes.append(f"{k}: sheet says {v!r}; only its leading code {code_of(value)!r} is the value")
                value = code_of(value)
            if value != v and not f.get("codeOnly"): notes.append(f"{k}: sheet says {v!r}, the page renders {value!r}")
        steps.append({"action": f["action"], "selector": f["selector"], "value": value,
                      "intent": f"Test data: {k} = {v}"})
        current[nk] = displayed(f, value)
        used.add(nk); return True

    unperformed: list[dict] = []

    def unperformable(goal: str, has_script: bool) -> str | None:
        """The lint's leg rules, asked before the leg exists."""
        if OUT_OF_BAND.search(goal):
            return "an instruction for a person or another system, not a browser action"
        has_value = " = " in goal or "set " in goal
        if not has_value and re.search(r"mandatory|ที่จำเป็น|required fields", goal, re.I):
            return "the field map's $required already enters the mandatory fields as verified steps"
        if not has_value and re.search(r"กรอก|fill", goal, re.I) and re.search(r"ครบถ้วน|ให้ครบ|ตาม[^\n]{0,30}Test Data|ชุดข้อมูล", goal):
            return "a fill-in instruction naming no values; the sheet's pairs and the field map's $required already enter these as verified steps"
        if not has_value and not UI_VERB.search(goal):
            return "names no value and no action a page can take"
        if re.search(r"ตาม Test Data\s*\(", goal) and not has_value:
            return "defers to Test Data the sheet does not state as pairs"
        if re.search(r"เลือก|choose|select", goal, re.I) and " = " not in goal and not has_script:
            return "says to choose but names no value"
        for m in re.finditer(r'"([^"]+)"\s*=\s*"([^"]*)"', goal):
            if CONSTRAINT.search(m.group(2)):
                return f"hands the constraint {m.group(2)!r} over as a value"
        if len(re.findall(r'"[^"]+"\s*=\s*"', goal)) > LEG_FIELD_MAX:
            return f"carries more than {LEG_FIELD_MAX} fields"
        return None

    def code_of(v: str) -> str:
        m = re.match(r"\s*([A-Za-z0-9_]+)", v or "")
        return m.group(1) if m else v

    def shown_for(f: dict, value: str) -> str:
        """What the page shows once `value` is in: a date in the control's own
        format, a masked id with its punctuation, anything else as given."""
        if f.get("kind") == "date" and f.get("display") and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            from datetime import date as _d
            y, mo, dd = (int(x) for x in value.split("-"))
            return _d(y, mo, dd).strftime(f["display"])
        return displayed(f, value)

    def required_value(spec: dict) -> str | None:
        """A required field's value: a literal, another field's date, or a row
        of a map keyed on what another field holds. None means the application
        supplies it for this case and nothing is typed."""
        sk = spec.get("skipWhen")
        if sk and re.search(sk["matches"], current.get(norm(sk["field"]), "") or ""): return None
        if "from" in spec:
            from datetime import date as _d, timedelta
            base = state.get("hire_date") if norm(spec["from"]) == "hire date" else None
            if not base: base = _d.today().isoformat()
            y, mo, dd = (int(x) for x in base.split("-"))
            return (_d(y, mo, dd) + timedelta(days=int(spec.get("plusDays", 0)))).isoformat()
        if spec.get("generate") == "thai-national-id":
            # Unique per run: a fixed id is accepted once, and every later case
            # then meets the person the first one created (21300078, 2026-09-21).
            import hashlib
            seed = int(hashlib.sha256(probe.encode()).hexdigest(), 16)
            d = [1] + [int(c) for c in f"{seed % 10**11:011d}"]
            d.append((11 - sum(v * (13 - i) for i, v in enumerate(d)) % 11) % 10)
            return "".join(map(str, d))
        if "byField" in spec:
            held = code_of(current.get(norm(spec["byField"]["field"]), ""))
            return spec["byField"]["map"].get(held)
        return spec.get("value")

    def ensure_page2(why: str) -> None:
        if state["moved_on"]: return
        if not (fmap.get("controls") or {}).get("next"): return
        steps.extend(advance_gate("next", why))
        for extra in ((fmap.get("$afterAdvance") or {}).get("next") or []):
            sel = (fmap.get("controls") or {}).get(extra.get("control", ""))
            if sel: steps.append({"action": extra["action"], "selector": sel, "intent": extra.get("intent", "")})
        state["moved_on"] = True
        for nk in list(current):
            if nk not in step2: current.pop(nk, None)   # that page is behind us

    def leg(goal: str, script: list[dict] | None = None) -> None:
        why = unperformable(goal, bool(script))
        if why:
            # Emitting it would spend agent turns on a leg that cannot succeed
            # and the lint would refuse the whole flow; recorded instead, so the
            # report can say which sheet instruction was not performed and why.
            unperformed.append({"goal": goal[:200], "why": why})
            notes.append(f"NOT PERFORMED — {why}: {goal[:90]}")
            return
        step = {"action": "workflow", "goal": goal}
        if script: step["script"] = script
        steps.append(step)
        state["legs"] += 1

    searchable = set(fields) | set(by_key) | agent_only

    def submit_at() -> int:
        """Where the record gets created — a gated click on the submit control,
        or a leg that says so. Everything the sheet asked for goes in before it,
        or the record is created without it."""
        sub = (fmap.get("controls") or {}).get("submit")
        for i, x in enumerate(steps):
            if sub and x["action"] == "click" and x.get("selector") == sub: return i
            if x["action"] == "workflow" and SUBMIT_WORD.search(x.get("goal", "")): return i
        return len(steps)

    def advance_gate(control_key: str, why: str) -> list[dict]:
        """Everything a page needs before it is allowed to advance, and the
        proof that it did.

        A press that succeeds mechanically is not an advance. The application
        may answer with a validation dialog and stay where it was, and a flow
        that does not look will fill the next page's fields into the old one.
        So: prove the fields are in, press, then prove the page moved and that
        nothing is objecting.
        """
        adv = fmap.get("$advance") or {}
        out: list[dict] = []
        # 1. every field this flow put on the page it is leaving must still hold
        #    a value — the application lists exactly these when it refuses.
        leaving_later_page = control_key != "next"
        for nk, val in list(current.items()):
            f2 = fields.get(nk)
            if not f2 or (nk in step2) != leaving_later_page: continue
            if f2.get("action") not in ("fill", "selectOption"): continue
            out.append({"action": "expectValue", "selector": f2["selector"], "value": val,
                        "intent": f"ก่อนไปหน้าถัดไป: {nk} ต้องเป็น {val} จริง "
                                 f"(ฟอร์มจะปฏิเสธและขึ้น dialog ถ้ายังว่างหรือผิด)"})
        # 2. the press itself
        ctrl = (fmap.get("controls") or {}).get(control_key)
        if ctrl: out.append({"action": "click", "selector": ctrl, "intent": why})
        # 3. no dialog is objecting, and the page really moved
        dlg = adv.get("errorDialog")
        if dlg:
            # Read what the application says before judging it: the dialog's
            # own text names the fields it refuses over, and a verdict of
            # "still visible" alone sends the next person to the screenshot.
            out.append({"action": "when", "visible": dlg,
                        "intent": "ถ้ามี dialog ขึ้นมา ให้อ่านข้อความของมันเก็บไว้เป็นหลักฐาน",
                        "then": [{"action": "saveText", "selector": dlg, "as": f"refused_{control_key}",
                                  "intent": "ข้อความใน dialog: ฟอร์มปฏิเสธเพราะอะไร"}]})
            out.append({"action": "expectHidden", "selector": dlg,
                        "intent": "ไม่มี dialog แจ้ง validation ค้างอยู่ — "
                                 "การกดที่สำเร็จเชิงกลไกไม่ใช่การไปต่อ"})
        left = adv.get("leavesBehind") if not state["moved_on"] else None
        if left:
            out.append({"action": "expectHidden", "selector": left,
                        "intent": "หน้าเดิมไปแล้วจริง (ตัวบอกหน้าเดิมต้องหายไป)"})
        return out

    def keys_named_in(text: str) -> list[str]:
        """Keys this sentence names — from the field map, the row's own Test
        Data and the agent-only list — longest first. Matched on word
        boundaries so `district` is not swallowed by `sub-district`."""
        out: list[str] = []
        for nk in sorted(searchable, key=len, reverse=True):
            if len(nk) < 3: continue
            pat = r"(?<![\w-])" + re.escape(nk).replace(r"\ ", r"\s*") + r"(?![\w-])"
            if re.search(pat, text, re.I): out.append(nk)
        return out

    def script_for(line: str, alt: bool = False) -> list[dict]:
        """Concrete fallback for a bullet that says to choose without saying
        which. Values come from the field map's observed samples, never from
        the model. Ordered as the form is: a Sub-District cannot be picked
        before its District."""
        order = list(fields)
        # "…ใหม่" / "again" means put back what a previous bullet changed, so a
        # control the sheet named is re-selected rather than skipped.
        again = bool(re.search(r"ใหม่|again|re-?select", line, re.I))
        picked: list[str] = []
        # Only the controls this bullet actually asks for — the object of its
        # verb — not every control the sentence happens to mention.
        for m in re.finditer(r"(?:เลือก|choose|select)\s+(.{2,60}?)(?=\s*(?:และ|,|\band\b|\bthen\b|$))",
                             line, re.I):
            for nk in keys_named_in(m.group(1)):
                if nk not in picked: picked.append(nk)
        if not picked:
            for sec, members in sections.items():
                if not re.search(SECTION_WORDS.get(sec, sec), line, re.I): continue
                picked += [nk for nk in members if nk not in picked]
        out = []
        for nk in sorted(picked, key=lambda x: order.index(x) if x in order else 99):
            f = fields.get(nk)
            if not f or f.get("action") != "selectOption": continue
            if nk in by_key and not alt and not again: continue   # the sheet named a value
            v = None
            if nk in by_key and again:
                v = rendered(nk, by_key[nk][1])          # back to the sheet's value
            if v is None: v = f.get("alt" if alt else "sample")
            if v: out.append({"action": "selectOption", "selector": f["selector"],
                              "value": v, "url": ""})
        return out

    # Fields the form refuses to submit without that the sheet never states.
    req = fmap.get("$required") or {}
    req_agent = {k: v for k, v in (fmap.get("$requiredViaAgent") or {}).items()
                 if not k.startswith("$")}

    def required_for(line: str) -> list[str]:
        """Picker-only required fields this bullet is the right moment for."""
        out = []
        for label, val in list(req_agent.items()):
            if re.search(r"(?<![\w-])" + re.escape(label.split(" (")[0]) + r"(?![\w-])", line, re.I) \
               or (label in ("Phone Number", "Email")
                   and re.search(r"contact|ติดต่อ|identity|ตัวตน|phone|email|โทร|อีเมล", line, re.I)):
                out.append(f'"{label}" = "{val}" (required by the form; the sheet states none)')
                del req_agent[label]
        return out

    # The probe identity is this run's handle on its own record.
    for nk, val in (("first name (en)", probe), ("last name (en)", "Keyin")):
        f = fields.get(nk)
        if f:
            steps.append({"action": f["action"], "selector": f["selector"], "value": val,
                          "intent": f"probe identity — {nk} (ทำให้ DB evidence ชี้ที่รอบนี้ได้)"})
            used.add(nk)

    # Identity values the sheet states go in now, on the page that holds them. A
    # sheet that names Company under "Position & Organization" had it entered
    # after the Next click — typed at a page that no longer shows the control,
    # while page 1 was refused for lacking it (1.030, 1.061, 1.068; Event Reason
    # on 1.013; 2026-09-21). Identity fields do not interact with the address
    # clearing checks, so entering them early changes nothing a step asserts.
    for nk in [k for k in by_key if k in sections.get("identity", set())]:
        if nk in used or nk in step2 or nk in derived or nk not in fields: continue
        emit_pair(nk)

    for nk, spec in req.items():
        f = fields.get(norm(nk))
        if not f or norm(nk) in used: continue
        if norm(nk) in step2: continue          # entered once that page is reached
        if norm(nk) in by_key: continue      # the sheet states it; the sheet wins
        value = required_value(spec)
        if value is None: continue
        if norm(nk) == "hire date": state["hire_date"] = value
        steps.append({"action": f["action"], "selector": f["selector"], "value": value,
                      "intent": f"GENERATED by the author — {spec['why']}"})
        current[norm(nk)] = shown_for(f, value)   # the gate verifies what the page shows
        used.add(norm(nk))

    # Identity must be provably complete before the Address section is touched:
    # the form reveals Address only then, and a Province set too early is
    # refused with no reason recorded (runs jev7 and jev9).
    # ---- the sheet's steps, in the sheet's order, each owning its own data ----
    sheet_steps = steps_of(tsteps)
    catch_all = next((st for st in sheet_steps
                      if re.search(r"ตาม\s*Test\s*Data", st["title"], re.I)), None)

    for st in sheet_steps:
        body_lines = [st["title"]] + st["bullets"]
        body = " ".join(body_lines)
        if LOGIN_STEP.match(st["title"]):
            notes.append(f"step {st['n']} is the sign-in — setup already did it"); continue

        # Which of the sheet's own pairs belong to this step: the ones its words
        # name, plus — for the "ตาม Test Data" step — every unclaimed pair of the
        # sections this step is about.
        owned: list[str] = []
        for line in body_lines:
            for nk in keys_named_in(line):
                if nk in by_key and nk not in used and nk not in owned: owned.append(nk)
        if st is catch_all:
            for sec, members in sections.items():
                if not re.search(SECTION_WORDS.get(sec, sec), body, re.I): continue
                for nk in members:
                    if nk in by_key and nk not in used and nk not in owned: owned.append(nk)

        if any(nk in step2 for nk in owned) or re.search(SECTION_WORDS["position"], body, re.I):
            ensure_page2(f"Step {st['n']}: ไปหน้าถัดไปของฟอร์ม ซึ่งเป็นที่อยู่ของ field ชุดนี้")

        # Bullet by bullet, so the flow performs the step the way it is written.
        acted = False
        has_bullets = len(st["bullets"]) > 0
        for line in body_lines:
            is_title = line is st["title"]
            if is_title and has_bullets:
                continue          # a heading; its bullets carry the work
            named = [nk for nk in keys_named_in(line) if nk in owned and nk not in used]

            # "เปลี่ยน Province และตรวจสอบว่า … ถูกเคลียร์" is two instructions.
            # Asserting the clearing without performing the change asserts the
            # state the page was already in, which passes while proving nothing.
            if CLEARS.search(line):
                # "เปลี่ยน District โดยคง Province เดิม และตรวจสอบว่า Sub-District /
                # Postal Code เดิมถูกเคลียร์" names three controls and clears
                # only two: the one it says to keep is not one of them. Read the
                # cleared ones from the clause that says so.
                span = re.search(r"(?:ตรวจสอบว่า|verify that|check that)(.*?)(?:ถูกเคลียร์|cleared)",
                                 line, re.I | re.S)
                scope = span.group(1) if span else line
                keep = re.search(r"(?:โดยคง|คง|keeping|keep)\s+([A-Za-z][A-Za-z .-]{2,30})", line, re.I)
                kept = norm(keep.group(1)) if keep else None
                targets = [nk for nk in keys_named_in(scope) if nk in fields and nk != kept]
                # The control to change is read from the whole line; the cleared
                # ones from the clause that names them. Scoping both to the
                # clause dropped the change itself and left the flow asserting
                # a clearing it had never caused.
                m = re.search(r"(?:เปลี่ยน|change)\s+([A-Za-z][A-Za-z .-]{2,30})", line, re.I)
                after = norm(m.group(1)) if m else ""
                changing = [nk for nk in keys_named_in(line)
                            if nk in fields and after and (nk == after or after.startswith(nk))][:1]
                # A clearing check needs something to clear. When an earlier
                # bullet already cleared one of these controls and nothing has
                # re-set it, the assertion passes on an empty field and proves
                # nothing — so fill it first, from the same observed sample.
                for nk2 in targets:
                    if current.get(nk2): continue
                    f2 = fields.get(nk2) or {}
                    if f2.get("action") != "selectOption" or not f2.get("sample"): continue
                    steps.append({"action": "selectOption", "selector": f2["selector"],
                                  "value": f2["sample"],
                                  "intent": f"Step {st['n']}: ตั้งค่า {nk2} ก่อน "
                                           f"เพื่อให้การตรวจ 'ถูกเคลียร์' มีของให้เคลียร์จริง"})
                    current[nk2] = f2["sample"]
                if changing:
                    nk = changing[0]
                    f2 = fields.get(nk) or {}
                    if f2.get("alt") and f2.get("action") == "selectOption":
                        steps.append({"action": "selectOption", "selector": f2["selector"],
                                      "value": f2["alt"],
                                      "intent": f"Step {st['n']}: เปลี่ยน {nk} เป็นค่าอื่น "
                                               f"เพื่อตรวจการเคลียร์ค่าที่ขึ้นกับมัน"})
                        current[nk] = f2["alt"]
                    else:
                        leg(f"Step {st['n']}: change \"{nk}\" to a different value than the one "
                            f"already selected (test step {st['n']})")
                for nk in targets:
                    f = fields.get(nk)
                    if not f or f["action"] == "fill" or nk in changing: continue
                    had = current.get(nk)
                    if had:
                        # The dependent control is renamed to a placeholder
                        # rather than blanked, and which placeholder depends on
                        # whether its parent is empty or merely different — only
                        # the first was ever observed. What the claim actually
                        # says is that the old value is gone, so assert that.
                        steps.append({"action": "expectHidden", "selector": f"text={had}",
                                      "intent": f"Step {st['n']}: {line[:100]} — {nk} ไม่แสดงค่าเดิม "
                                               f"({had}) อีกต่อไป"})
                        current.pop(nk, None)
                    else:
                        notes.append(f"step {st['n']}: {nk} holds nothing at this point, so "
                                     f"'ถูกเคลียร์' would assert an already-empty field — not asserted")
                acted = True
                continue

            # A verification instruction never sets anything: the values it
            # names are the criteria it checks against, not fields to fill.
            if VERIFY_ONLY.match(line.strip()):
                notes.append(f"step {st['n']} bullet reads only: {line.strip()[:60]}")
                continue

            covered = [sec for sec, members in sections.items()
                       if re.search(SECTION_WORDS.get(sec, sec), line, re.I)
                       and any(norm(k) in members for k in (fmap.get("$required") or {}))]
            # …unless the bullet is a "choose" the map can perform from its samples
            # (the address re-fill after the clearing checks) — that path acts.
            performable = bool(re.search(r"เลือก|choose|select", line, re.I) and script_for(line))
            if not named and covered and not performable:
                notes.append(f"step {st['n']}: \"{line.strip()[:60]}\" names no values; the field map "
                             f"supplies section {', '.join(covered)} — entered as steps, no leg")
                acted = True
                continue
            det = [nk for nk in named if emit_pair(nk)]
            acted = acted or bool(det)
            # A value the application fills itself is never handed to a leg:
            # an agent told to set a read-only box answers BLOCKED, correctly.
            rest = [nk for nk in named if nk not in used and nk not in derived]
            stated = [nk for nk in keys_named_in(line) if nk in by_key]
            if not rest and not det and stated and all(nk in used or nk in derived for nk in stated) \
               and not SUBMIT_WORD.search(line) and not re.search(r"ค้นหา|search", line, re.I):
                # Its values went in earlier, on the page that holds them. A leg
                # here asks the agent to set what is already set; it answered
                # BLOCKED or claimed a finish the page did not show on six cases.
                notes.append(f"step {st['n']}: \"{line.strip()[:60]}\" — already entered as verified steps")
                acted = True
                continue
            if rest or not det:
                lits = [clause_for(by_key[nk][0], rendered(nk, by_key[nk][1]))
                        for nk in rest if nk in by_key]
                if SUBMIT_WORD.search(line) and (fmap.get("controls") or {}).get("submit"):
                    steps.extend(advance_gate("submit", f"Step {st['n']}: {line.strip()[:140]}"))
                    acted = True
                    continue
                goal = f"Step {st['n']}: {line.strip()[:200]}"
                if re.search(r"ค้นหา|search", line, re.I):
                    goal += (f' — the employee this run created is the one named "{probe}"; '
                             f"search for that name")
                _held = dict(req_agent)
                goal += phrase(lits + required_for(line))
                sc = script_for(line) if re.search(r"เลือก|choose|select", line, re.I) else []
                if sc:
                    # The field map names the control and an observed value, so
                    # a deterministic rung can do this. Asking an agent instead
                    # is a gamble that answered BLOCKED at p=0.3–0.4 across five
                    # runs; every control we can drive ourselves, we drive.
                    for entry in sc:
                        steps.append({"action": entry["action"], "selector": entry["selector"],
                                      "value": entry["value"],
                                      "intent": f"Step {st['n']}: {line.strip()[:120]}"})
                        for nk2, f2 in fields.items():
                            if f2.get("selector") == entry["selector"]: current[nk2] = entry["value"]
                    for nk in rest: used.add(nk)
                    acted = True
                    continue
                _n = len(unperformed)
                leg(goal + f" (test step {st['n']})")
                if len(unperformed) > _n: req_agent.clear(); req_agent.update(_held)   # they still need a leg
                for nk in rest: used.add(nk)
                acted = True
        # A step whose title carried the only work (no bullets at all).
        if has_bullets and not acted and not VERIFY_ONLY.match(st["title"].strip()):
            leftover = [nk for nk in owned if nk not in used]
            if leftover:
                clause = ", ".join(clause_for(by_key[nk][0], rendered(nk, by_key[nk][1]))
                                   for nk in leftover if nk in by_key)
                if clause:
                    leg(f"Step {st['n']}: {st['title'][:140]} — set {clause} (test step {st['n']})")
                    for nk in leftover: used.add(nk)
                    acted = True
        if not acted:
            notes.append(f"step {st['n']} needed no action — its Expected lines carry it")

    # Data the sheet stated that no step named. Where it goes is decided by the
    # section it belongs to: a page-1 identity or address field entered after
    # the Next click is typed into a page that no longer shows it.
    withheld = sorted(nk for nk in derived if nk not in used and (nk in agent_only or nk in fields))
    stray = [nk for nk in by_key if nk not in used and nk not in derived and (nk in agent_only or nk in fields)]
    if withheld:
        notes.append("the application fills " + ", ".join(by_key[nk][0] for nk in withheld)
                     + " (the Expected output says it is pulled or derived) — never typed")
    if stray:
        page1 = [nk for nk in stray
                 if nk not in step2 and any(nk in sections.get(sec, set())
                                            for sec in ("identity", "address"))]
        page2 = [nk for nk in stray if nk not in page1]

        def block_for(keys: list[str]) -> list[dict]:
            mark = len(steps)
            for nk in keys: emit_pair(nk)
            out = steps[mark:]
            del steps[mark:]
            rest = [nk for nk in keys if nk not in used]
            # One leg per LEG_FIELD_MAX fields: four in one leg answered BLOCKED
            # at p=0.35 on every run that reached page 2.
            for i in range(0, len(rest), LEG_FIELD_MAX):
                chunk = rest[i:i + LEG_FIELD_MAX]
                clause = ", ".join(clause_for(by_key[nk][0], rendered(nk, by_key[nk][1])) for nk in chunk)
                goal = f"Enter the test data the case states: set {clause}"
                for nk in chunk: used.add(nk)
                why = unperformable(goal, False)
                if why:
                    unperformed.append({"goal": goal[:200], "why": why})
                    notes.append(f"NOT PERFORMED — {why}: {goal[:90]}")
                    continue
                out.append({"action": "workflow", "goal": goal})
                state["legs"] += 1
            return out

        if page1:
            blk = block_for(page1)
            nxt = (fmap.get("controls") or {}).get("next")
            click_at = next((i for i, x in enumerate(steps) if x.get("selector") == nxt), len(steps))
            # Ahead of the gate, not between the gate and the press: a field set
            # after the checks ran is a field nothing verified.
            GATE = "ก่อนไปหน้าถัดไป"
            gate_at = next((i for i, x in enumerate(steps[:click_at])
                            if str(x.get("intent", "")).startswith(GATE)), click_at)
            steps[gate_at:gate_at] = blk
            click_at += len(blk)
            checks = [{"action": "expectValue", "selector": x["selector"], "value": current.get(nk2, x.get("value")),
                       "intent": f"{GATE}: {nk2} ต้องเป็น {current.get(nk2, x.get('value'))} จริง"}
                      for x in blk if x["action"] in ("fill", "selectOption")
                      for nk2, f2 in fields.items() if f2.get("selector") == x["selector"]][:len(blk)]
            steps[click_at:click_at] = checks
        if page2:
            blk = block_for(page2)
            if any(nk in step2 for nk in page2): ensure_page2("ไปหน้าถัดไปของฟอร์มก่อนกรอกข้อมูลที่เหลือ")
            at = submit_at()
            GATE = "ก่อนไปหน้าถัดไป"
            while at > 0 and str(steps[at - 1].get("intent", "")).startswith(GATE): at -= 1
            steps[at:at] = blk
            # The submit gate was written when the sheet's step was read, before
            # these were placed; a field entered and never checked is how
            # Employee Group went in "rescued" and empty on 2026-09-21.
            have = {x.get("selector") for x in steps if x["action"] == "expectValue"}
            checks = [{"action": "expectValue", "selector": x["selector"], "value": current.get(nk2, x.get("value")),
                       "intent": f"{GATE}: {nk2} ต้องเป็น {current.get(nk2, x.get('value'))} จริงก่อนกด Submit"}
                      for x in blk if x["action"] in ("fill", "selectOption") and x["selector"] not in have
                      for nk2, f2 in fields.items() if f2.get("selector") == x["selector"]]
            seen_sel, uniq = set(), []
            for c in checks:
                if c["selector"] in seen_sel: continue
                seen_sel.add(c["selector"]); uniq.append(c)
            sub = submit_at()
            steps[sub:sub] = uniq

    later = [(norm(nk), spec) for nk, spec in req.items()
             if norm(nk) in step2 and norm(nk) not in used and norm(nk) not in by_key and fields.get(norm(nk))]
    if later:
        ensure_page2("ไปหน้าถัดไปของฟอร์มก่อนกรอก field ที่หน้านั้นบังคับ")
        blk = []
        for nk, spec in later:
            f = fields[nk]
            value = required_value(spec)
            if value is None: continue
            blk.append({"action": f["action"], "selector": f["selector"], "value": value,
                        "intent": f"GENERATED by the author — {spec['why']}"})
            current[nk] = shown_for(f, value); used.add(nk)
        at = submit_at()
        # ahead of the submit's own gate checks, so they are verified too
        GATE = "ก่อนไปหน้าถัดไป"
        while at > 0 and str(steps[at - 1].get("intent", "")).startswith(GATE): at -= 1
        by_sel = {f2["selector"]: nk2 for nk2, f2 in fields.items()}
        checks = [{"action": "expectValue", "selector": x["selector"],
                   "value": current.get(by_sel.get(x["selector"], ""), x["value"]),
                   "intent": f"{GATE}: ต้องเป็น {current.get(by_sel.get(x['selector'], ''), x['value'])} จริงก่อนกด Submit"}
                  for x in blk]
        steps[at:at] = blk
        sub = submit_at()
        steps[sub:sub] = checks

    if req_agent:
        clause = ", ".join(f'"{k}" = "{v}"' for k, v in req_agent.items())
        # These belong to the Identity section, and the form reveals the Address
        # section only once Identity is complete. Deferring them past the
        # address steps left Province unreachable on every run up to
        # 2026-09-18 18:41 — so the leg lands before the first address control.
        # After every identity field this author drives itself, and before the
        # first address control that gates on Identity being complete. A plain
        # text box does not gate, so only the pickers count.
        nxt_sel = (fmap.get("controls") or {}).get("next")
        nxt_at = next((i for i, x in enumerate(steps) if x.get("selector") == nxt_sel), len(steps))
        last_gen = max((i for i, x in enumerate(steps[:nxt_at])
                        if str(x.get("intent", "")).startswith("GENERATED")), default=None)
        addr = {fields[nk]["selector"] for nk in sections.get("address", set())
                if nk in fields and fields[nk].get("action") != "fill"}
        first_addr = next((i for i, x in enumerate(steps) if x.get("selector") in addr), None)
        at = None
        if last_gen is not None:
            at = last_gen + 1
            if first_addr is not None and at > first_addr: at = first_addr
        elif first_addr is not None:
            at = first_addr
        if at is None:
            nxt = (fmap.get("controls") or {}).get("next")
            at = next((i for i, x in enumerate(steps) if x.get("selector") == nxt), None)
        if at is None:
            at = submit_at()
        steps.insert(at, {"action": "workflow",
                          "goal": f"Complete the fields the form requires that the case does not "
                                  f"state: set {clause}"})
        state["legs"] += 1

    # Identity must be provably complete, and the address section in view,
    # immediately before the first address picker — not merely somewhere
    # earlier. Both are inserted once the order is settled.
    addr_sel = [fields[nk]["selector"] for nk in sections.get("address", [])
                if nk in fields and fields[nk].get("action") == "selectOption"]
    first_addr = next((i for i, x in enumerate(steps) if x.get("selector") in addr_sel), None)
    if first_addr is not None:
        pre = []
        gate = fmap.get("$identityGate") or {}
        gate_f = fields.get(norm(gate.get("field", "")))
        gate_val = current.get(norm(gate.get("field", ""))) if gate_f else None
        if gate_f and gate_val:
            pre.append({"action": "expectValue", "selector": gate_f["selector"],
                        "value": gate_val,
                        "intent": f"Identity ครบก่อนเข้าส่วน Address — {gate.get('why', '')[:90]}"})
        # The pickers sit at the foot of a long form and their list opens
        # downward; left at the page's own scroll position the list renders
        # off-screen and the selection is refused in under a second with
        # nothing recorded (runs jev7/9/10 — the failure screenshot shows
        # Province on the last visible line).
        pre.append({"action": "scrollTo", "selector": steps[first_addr]["selector"],
                    "intent": "เลื่อนส่วน Address เข้ามาในจอ ก่อนเปิด dropdown"})
        steps[first_addr:first_addr] = pre

    # A control that exists only after another is pressed ("+ Add Phone") gets
    # that press first — guarded, so a form that already shows it is left alone.
    reveal = {f2["selector"]: f2["revealedBy"] for f2 in fields.values() if f2.get("revealedBy")}
    i = 0
    while i < len(steps):
        x = steps[i]
        if x["action"] in ("fill", "selectOption") and x.get("selector") in reveal:
            prev = steps[i - 1] if i else {}
            if prev.get("action") != "when":
                steps.insert(i, {"action": "when", "hidden": x["selector"],
                                 "intent": "ช่องนี้ยังไม่ถูกเพิ่มในฟอร์ม — กดปุ่มเพิ่มก่อน",
                                 "then": [{"action": "click", "selector": reveal[x["selector"]],
                                           "intent": "เพิ่มช่องกรอกก่อนพิมพ์ค่า"}]})
                i += 1
        i += 1

    # Every picker is brought into view before it is opened. A list or calendar
    # that opens downward from a control near the bottom of the viewport renders
    # off-screen: the option is found and cannot be clicked. Seen on Province
    # (jev7–jev10), on Pay Group and Bank, and — once scrolling was per section
    # only — again on Employee Group and the two start dates inside sections
    # that are taller than the screen (2026-09-21). Per control, not per section.
    i = 0
    while i < len(steps):
        x = steps[i]
        opens = x["action"] == "selectOption" or (x["action"] == "fill" and str(x.get("selector", "")).startswith("role=button"))
        if opens:
            prev = steps[i - 1] if i else {}
            if not (prev.get("action") == "scrollTo" and prev.get("selector") == x["selector"]):
                steps.insert(i, {"action": "scrollTo", "selector": x["selector"],
                                 "intent": "เลื่อน control เข้ามาในจอก่อนเปิดรายการหรือปฏิทิน"})
                i += 1
        i += 1

    # Read-backs the Expected lines are judged against.
    for nk, var in (("time management status", "tm_status"), ("o.t. flag", "ot_flag"),
                    ("postal code", "postal_code"), ("employee id", "emp_id")):
        f = fields.get(nk)
        if f:
            steps.append({"action": "saveText", "selector": f["selector"], "as": var,
                          "intent": f"บันทึกค่า {nk} ไว้เทียบใน Expected result"})

    # ---- assertions ----------------------------------------------------------
    INSTRUCTION = re.compile(r"ตาม|เลือก|ยังไม่|ดูชีท|อัตโนมัติ|ต้อง|ระบบ|\?")
    TOO_GENERIC = {"no", "yes", "0", "1", "-", "active"}
    asserted, skipped = 0, 0
    for e in expected_lines(exp):
        m = PAIR.match("- " + e["text"])
        if not m: skipped += 1; continue
        k, v = m.group("k").strip(), m.group("v").strip()
        if INSTRUCTION.search(v) or len(v) > 40 or NOT_A_VALUE.match(v):
            notes.append(f'expected "{e["text"][:60]}" states no literal value — recorded, not asserted')
            skipped += 1; continue
        f = fields.get(norm(k))
        if f:
            steps.append({"action": "expectValue", "selector": f["selector"],
                          "value": rendered(norm(k), v), "intent": f'{e["mod"]}: {e["text"]}'})
        elif v.lower() in TOO_GENERIC or len(v.strip()) < 3:   # the lint's own floor
            notes.append(f'expected "{e["text"][:60]}" — {v!r} is too generic for a text match')
            skipped += 1; continue
        else:
            steps.append({"action": "expectText", "selector": f"text={v}", "value": v,
                          "intent": f'{e["mod"]}: {e["text"]}'})
        asserted += 1

    flow = {
        "name": f"{row.get('No.', '').strip()} {title}".strip() or "case",
        "baseUrl": base_url,
        "caseContext": f"Case: {title}\nExpected: {exp[:400]}\nTest data: {tdata[:400]}",
        "setup": setup,
        "steps": steps,
    }
    return {"flow": flow, "summary": {
        "persona": persona, "route": route, "pairsRead": len(all_pairs),
        "pairsPlaced": len(used), "pairsUnplaced": sorted(set(by_key) - used),
        "deterministicSteps": sum(1 for s in steps if s["action"] in ("fill", "selectOption", "click")),
        "agentLegs": state["legs"], "assertions": asserted, "expectedNotAsserted": skipped,
        "readBacks": sum(1 for s in steps if s["action"] == "saveText"),
        "unperformed": unperformed, "notes": notes}}

def form_reads_before_submit(steps: list[dict], fmap: dict) -> list[dict]:
    """A read-back or assertion on one of the FORM's controls belongs before
    the Submit press. After a successful submit the form is gone — the page is
    the new employee's profile — and every such step dead-ends on a control that
    no longer exists: five of them on the first run that ever submitted
    (hrsit 1.001, 2026-09-21, employee 21300078). What is left after the press
    is what the sheet checks on the record: the search legs and text the profile
    shows."""
    sub = (fmap.get("controls") or {}).get("submit")
    at = next((i for i, x in enumerate(steps) if x["action"] == "click" and x.get("selector") == sub), None)
    if at is None: return steps
    form = {f.get("selector") for f in (fmap.get("fields") or {}).values()}
    late = [x for x in steps[at + 1:] if x.get("selector") in form
            and x["action"] in ("saveText", "expectValue", "waitFor", "expectVisible")]
    if not late: return steps
    keep = [x for x in steps[at + 1:] if not any(x is y for y in late)]
    head = steps[:at]
    # ahead of the gate's own checks, which stay the last thing before the press
    g = len(head)
    while g > 0 and str(head[g - 1].get("intent", "")).startswith("ก่อนไปหน้าถัดไป"): g -= 1
    return head[:g] + late + head[g:] + [steps[at]] + keep

def stop_at_refusal(steps: list[dict], fmap: dict) -> list[dict]:
    """Everything after an advance gate runs only if the gate held.

    The engine carries on past a failed step. When the application refuses a
    Submit, every later step searches for and reads back a record that was
    never created: about three minutes and most of a run's model spend, to
    produce failures that say nothing (hrsit-1001-pos, 2026-09-21). The gate's
    own failed `expectHidden` stays where it is as the verdict; what follows it
    moves into a `when hidden` on the same dialog."""
    dlg = (fmap.get("$advance") or {}).get("errorDialog")
    left = (fmap.get("$advance") or {}).get("leavesBehind")
    if not dlg: return steps
    ends = [i for i, x in enumerate(steps) if x["action"] == "expectHidden" and x.get("selector") == dlg]
    for g in reversed(ends):
        end = g + 1
        if end < len(steps) and steps[end]["action"] == "expectHidden" and steps[end].get("selector") == left:
            end += 1
        rest = steps[end:]
        if not rest: continue
        steps = steps[:end] + [{"action": "when", "hidden": dlg,
                                "intent": "ไปต่อเฉพาะเมื่อฟอร์มไม่ได้ปฏิเสธ — ถ้า dialog ยังค้าง ขั้นที่เหลือไม่มีอะไรให้ตรวจ",
                                "then": rest}]
    return steps

def flat(steps: list[dict]) -> list[dict]:
    """A flow's steps in run order with every branch inlined — what the lint and
    the counters read, so nesting hides nothing from them."""
    out: list[dict] = []
    for x in steps:
        out.append(x)
        for br in ("then", "else"):
            if isinstance(x.get(br), list): out.extend(flat(x[br]))
    return out

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True, type=Path)
    ap.add_argument("--row", default="")
    ap.add_argument("--fieldmap", required=True, type=Path)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--probe", required=True)
    ap.add_argument("--persona")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    row, _ = read_row(a.catalog, a.row)
    fmap = json.loads(a.fieldmap.read_text(encoding="utf-8"))
    built = build(row, fmap, a.base_url.rstrip("/"), a.probe, a.persona)
    built["flow"]["steps"] = stop_at_refusal(form_reads_before_submit(built["flow"]["steps"], fmap), fmap)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(built["flow"], ensure_ascii=False, indent=1), encoding="utf-8")
    s = built["summary"]; s["out"] = str(a.out); s["steps"] = len(flat(built["flow"]["steps"]))
    if a.json: print(json.dumps(s, ensure_ascii=False, indent=1))
    else:
        print(f"wrote {a.out}")
        print(f"  persona {s['persona']} · route {s['route']} · {s['steps']} steps "
              f"({s['deterministicSteps']} deterministic, {s['agentLegs']} agent legs, "
              f"{s['assertions']} assertions, {s['readBacks']} read-backs)")
        for n in s["notes"]: print(f"  note: {n}")

if __name__ == "__main__":
    main()
