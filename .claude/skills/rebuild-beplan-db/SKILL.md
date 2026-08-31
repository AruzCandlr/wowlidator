---
name: rebuild-beplan-db
description: Rebuild the local HRCenter-DEV replica's benefit_plan table to the be100 QA baseline — Total plans 75 / Reimbursement Employee+HR 68 / non-reimb 7. Use when the user says "rebuild BE plan db", "rebuild db", "restore 75/68", "reset benefit plan baseline", or before a be100 catalog run whose counts have rotted from earlier QA creates and deletes.
---

# Rebuild BE-plan DB to the be100 QA baseline (75/68)

Restores `benefit_management.benefit_plan` in the **local replica** (`localhost:5432`) to the
counts the be100.csv QA sequence starts from:

- **Total plans = 75** · **Reimbursement by Employee and HR = 68** · non-reimb = 7
- The QA create-case (PL_03_07) then moves it to 76/69, and delete (PL_03_10) back to 75/68.

The database belongs to the **app** repo, not this one. Everything below is written to run
from any working directory:

```bash
APP=/Users/ThArus/Documents/GitHub/cnext-hrms-fortest
```

## Steps

1. **Postgres up?** `pg_isready -h localhost -p 5432` — if not: `brew services start postgresql@18`.
2. **Seed the registry first — REQUIRED, never skip** (idempotent):
   ```bash
   curl -s -X POST http://localhost:3000/api/db/seed
   ```
   Requires the app's dev server on :3000 (`cd "$APP" && npm run dev` if it is down).
   The app's Delete is a hard delete, so baseline plans — including `TH_MED_001` and the
   other four clone templates — may be gone. Without this step the rebuild still reaches
   75/68 by cloning the surviving templates, silently leaving deleted baseline plans
   missing (this actually happened to `TH_MED_001` on 2026-08-25).
3. **Run the rebuild** (idempotent + self-correcting from any state; safe to re-run):
   ```bash
   psql "$(grep '^DATABASE_URL=' "$APP/.env.local" | cut -d= -f2-)" \
     -f "$CLAUDE_PROJECT_DIR/.claude/skills/rebuild-beplan-db/rebuild.sql"
   ```
   `$DATABASE_URL` in the app's `.env.local` is the same replica `WOWLIDATOR_DB_URL`
   points at for wowlidator's own DB checks.
4. **Verify** the script's output: the first select prints `75 | 68 | 7`, the
   `missing_template` select returns **0 rows** (a listed id means a template was
   hard-deleted and not re-seeded — redo step 2, then step 3), and
   `curl -s localhost:3000/api/db/health` shows `"benefitPlans":75`.

## What the SQL does (rebuild.sql, same directory)

1. Deletes every non-reimb plan except the 7 QA keepers
   (`TH_FAH_001/002/003`, `TH_PAT_001`, `TH_WED_001`, `TH_MOB_002`, `TH_CHI_001` —
   chosen because eligibility rules reference them heavily).
2. Tops up `REIMBURSEMENT_EMPLOYEE_HR` to exactly 68 by cloning real template rows
   (`TH_MED/DEN/CHK/GAS/TOL_001`) into numbered series ids (`TH_MED_002`…),
   stamped `created_by = 'CNEXT_MOCK'` per the app repo's tagging rule.
3. Trims newest `CNEXT_MOCK` fillers if a prior state overshot 68.

## Notes / gotchas

- **Local-only**: the replica is a one-way clone — nothing writes back to the real HRCenter-DEV.
- Fillers are disposable: `delete ... where created_by = 'CNEXT_MOCK'` removes them all.
- The app's DELETE endpoint is a **hard delete** and the catalog read is DB-authoritative,
  so QA deletes genuinely change these counts — re-run this between be100 rounds, not once.
- `benefit_eligibility_rule` is never touched; rules pointing at deleted plans dangle
  harmlessly (no FK).
- This rewrites shared test state. Run it only on the user's say-so.
