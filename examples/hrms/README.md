# HRMS backend catalog — cnext-hrms (`fortest`) against the HRCenter-DEV replica

Hand-runnable backend checks against your own system. Everything here is
read-only from wowlidator's side (the one write is made by the app's own API);
the driver is optional and the connection travels by env.

## Setup (once)

```bash
npm install pg                                            # optional driver
export WOWLIDATOR_DB_URL=postgres://localhost:5432/HRCenter-DEV   # your peer-auth user; loopback, so no --db-remote-ok
npm run cli -- doctor                                     # …should print:  ✓ db  read-only session up — N table(s) visible
```

The app must be running for the hybrid flow: `cd cnext-hrms-fortest && npm run dev`
(check which port it announces — this file assumes `localhost:3200`; edit `baseUrl` if yours differs).

## 1. Replica state — no app, no browser (`replica-state.flow.json`)

```bash
npm run cli -- run examples/hrms/replica-state.flow.json
```

Proves the benefit catalog is what the screens should show: the Dental and OPD
plans exist and are active, exactly three plans are active, every eligibility
rule is a STANDARD active rule, a made-up plan id does not exist, and reading
changed nothing. Seven checks, ~1s, $0.

## 2. Create Plan, end to end — app API → database (`create-plan.api.json`)

```bash
npm run cli -- run examples/hrms/create-plan.api.json
```

Calls the app's real `POST /api/benefit-plans` the way the catalog screen's
Create Plan does, saves the `dbId` it returns, and proves the row keyed by
**that id** holds every value the route maps from the UI shape (`dental` →
`Dental`, `active` → `A`, `reimbursement-hr` → `REIMBURSEMENT_HR`, …); +1 row
exactly; eligibility rules untouched; then an invalid body → 400 with zero
writes. This creates one real row named `BP-WOW-<n>` — remove it afterwards
(wowlidator cannot; it is read-only by construction):

```sql
delete from benefit_management.benefit_plan where benefit_plan_id like 'BP-WOW-%' and created_by = 'cnext-ui';
```

Edit the `id` in the flow before re-running, or the second run's insert
collides on the plan id (the route answers 500 — which the flow will
correctly report as the backend refusing).

## 2b. Entitlement rule lifecycle — create → update → delete → net zero (`eligibility-rules.api.json`)

```bash
npm run cli -- run examples/hrms/eligibility-rules.api.json
```

Exercises the whole `/api/workflow/admin/benefits/medical-reimbursement/eligibility`
surface: GET lists, POST creates a rule (`RULE-WOW-0001` on `BP-DENTAL-01`),
the row keyed by the returned id is proved to hold every mapped value
(`special` → `SPECIAL`, scope → `group`, audit stamp `created_by = 'cnext-ui'`),
+1 row exactly, plans untouched; PUT renames it and flips it inactive (proved
in the row, with `updated_by`); PUT on a made-up id → 404; DELETE removes the
row for real (the route hard-deletes) — and the closing `expectDbUnchanged`
proves the whole lifecycle netted to zero, so **this flow cleans up after
itself** and can be re-run as-is. If it breaks off midway, remove the leftover:

```sql
delete from benefit_management.benefit_eligibility_rule where rule_id = 'RULE-WOW-0001';
```

## 3. The sequence diagram as a catalog (`benefit-plan-create.mmd`)

```bash
npm run cli -- catalog examples/hrms/benefit-plan-create.mmd --claims-only
```

One claim per message, no model call. Watch the lanes: `API → DB: INSERT` and
`DB → API: id` come out **context, not checked** — beyond the browser boundary
— which is exactly the gap flow 2 closes with its DB checks. Then, with a
generator key in `.env` and the app running:

```bash
npm run cli -- context build --root ../cnext-hrms-fortest   # optional: with WOWLIDATOR_DB_URL set and no schema file, the live schema is introspected → authoring may write DB checks
npm run cli -- catalog examples/hrms/benefit-plan-create.mmd --claims <the claims file it wrote> --url http://localhost:3200/en/admin/benefits/plans --run
```

Or drop the `.mmd` into wowUI (`npm run ui -- --wow` → Add Catalog): the lane
table is editable there, and correcting a guessed plane recomputes the claims.

There is a second diagram, `eligibility-rule-lifecycle.mmd`, covering the full
rule CRUD (19 claims; the 6 API↔DB messages come out *context, not checked* —
the boundary — which is exactly what flow 2b's DB checks close):

```bash
npm run cli -- catalog examples/hrms/eligibility-rule-lifecycle.mmd --claims-only
```

## 4. Browser + traffic (`plans-page.flow.json`) — needs Chrome (the CLI starts it)

```bash
npm run cli -- run examples/hrms/plans-page.flow.json
```

Opens the plans screen and asserts the traffic the page makes plus the DB
state it should reflect. The `expectCalls` entry is written from the route the
app exposes; if the page reads plans through a Server Component rather than a
client fetch, that step reports NOT OBSERVED honestly — flip it to a
`never` claim or delete it, and the DB checks still stand.
