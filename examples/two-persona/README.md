# The two-persona benchmark

Every other `.flow.json` in this repository signs in exactly once. That made
every change to persona handling unmeasurable: the browser lease, the session
guard's per-persona memory, the agent's replay scope and the sign-in bootstrap
all behave differently the moment a case changes hands, and there was no
before/after row to put them in.

This is that row. It costs nothing to run — no real application, no real
credentials, no model, no network.

## Running it

```bash
node examples/two-persona/server.mjs &          # the application, on :3210
npm run chrome                                  # a Chrome to drive
npm run cli -- run examples/two-persona/handoff.flow.json \
  --persona '<HR_ADMIN_ACCOUNT>=admin@b.test:pw2026' \
  --persona 'MANAGER_ACCOUNT=manager@b.test:pw2026' \
  --no-heal --no-agent --report-dir /tmp/two-persona
```

`--no-heal --no-agent` keeps it at exactly $0 and makes the timing readable:
what is left is the ladder, the sign-ins and the switches, which is what this
flow is for.

## The baseline, measured 2026-09-04

Chrome on the configured CDP endpoint, headless, fixture on :3210. Two
consecutive runs, 7234 ms and 7223 ms — stable to ~10 ms.

| | |
|---|---|
| verdict | `passed`, 8/8 steps |
| wall | **7.2 s** |
| tokens | **0 in / 0 out** — no model is reachable from this flow |
| resolutions | `fast=6`, everything else 0 — no rung below the first was needed |
| the three sign-ins | 1623 ms (bind) + 2387 ms (hand-off) + 2408 ms (return) = **6.4 s** |
| everything else | 8 steps' worth of `goto` and `expectText`: **0.15 s** |

**89% of a two-persona case is its sign-ins, and none of that time appears in
any model-latency view** — a switch spends no tokens, so `joblog.mjs` and the
cost line say nothing about it. `signIn`'s own `durationMs` on the step is the
only place it shows. That is the number any change to persona handling has to
move, and the reason this file exists.

## What it proves, and what to read

| Step | The fact under it |
|---|---|
| `signIn <HR_ADMIN_ACCOUNT>` | the label is normalised — the sheet's angle brackets, the bare label and the email are one key |
| `expectText #who` | the page names the *account*, so the assertion is about identity, not merely about being signed in |
| `signIn MANAGER_ACCOUNT` | the hand-off: a second identity takes over, and the record says how |
| `signIn HR_ADMIN_ACCOUNT` | the return, and whether it cost a login |

In the proof bundle every step carries `persona` and `browser`, so the report
reads "steps 1–3 as HR_ADMIN, 4–6 as MANAGER" — and no persona password
appears anywhere in it (asserted, 2026-09-04).

## Two things this measures that are worth knowing before you read the numbers

**`wowlidator run` cannot give a persona its own Chrome.** `personaBrowsers` is
set in exactly one place — `src/cli/run-cases.ts`, the suite and catalog path,
where a case leases a lane per persona. A single-flow `run` passes `personas`
and never `personaBrowsers`, so **every switch here is a sign-out and a fresh
sign-in on one browser**, and `--browsers 2` does not change that (measured:
both runs above stayed on one endpoint and recorded `signedOutVia`). The
kept-session path — `keptSession: true`, no login form, ~0 ms for the return —
is reachable only through a catalog run, and is covered by the CDP-gated
assertions in `tests/session-bootstrap.test.ts`. Which means the 2.4 s return
in the table above is the *worst* case, and closing that gap in `run` would be
the single largest win this benchmark can show.

**`signIn.url` is not resolved against `baseUrl`, although `goto` is.** The
first attempt at this flow used `"url": "/login"` and died on
`Cannot navigate to invalid URL` while `{ "action": "goto", "url": "/app" }`
one line later resolved fine. The URL here is absolute for that reason, not by
preference.

## The credentials

Both accounts use the password `pw2026`, and the fixture accepts any email —
the personas a run declares are the only thing deciding who is signed in. They
are passed as `--persona LABEL=email:password`, which is fine against a local
fixture. Against a real application the passwords ride `WOWLIDATOR_PERSONAS`
(or the panel's launcher) and never reach a command line.
