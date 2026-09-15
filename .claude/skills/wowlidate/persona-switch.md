# Changing who you are acting as, in HUMI

This document is background for the authoring model. It asserts nothing: it
describes a control the application has, so a flow can use it instead of
inventing one. No claim in a test case may be read out of this file.

**It applies to HUMI only.** Another application's role switch, if it has one,
looks nothing like this.

## When it applies

A test script's **first** persona is established by signing in — that is the
harness's job and no flow step describes it.

Every *later* line that says to act as, access as, switch to, or "log in as"
another `<PERSONA>` is **not** a second sign-in. HUMI keeps one session and
lets that session take action on behalf of somebody else. So the second and
each following persona line is authored as the switch below, in the same
session, on the same browser.

The distinction in one line: **the first persona is a login; every persona
after it is a switch.**

## The procedure, control by control

Verified against `https://humi-sit-int.central.co.th/humi/en/me/home` on
2026-09-11. Names are exactly as the accessibility tree exposes them.

1. **Open the account menu.** Top right of the page chrome, an avatar showing
   the signed-in person's initials.

   `role=button[name="Account menu" i]` — it carries `aria-haspopup="menu"`.

2. **Choose the switch.** The menu holds exactly two items:

   `role=menuitem[name="Take Action on Behalf of…" i]`
   `role=menuitem[name="Sign out" i]`

   Take the first. **Never the second** — signing out ends the session the
   harness established and the run cannot get it back.

   The name ends in a single ellipsis character `…` (U+2026), not three
   full stops.

3. **The picker opens.** A `role=dialog` labelled `Take Action on Behalf of`,
   holding a search box and a list of people:

   - `role=textbox` with placeholder `Search by name, email, or role`
   - one `role=button` per person, whose accessible name is
     `<Full Name> <EmployeeID> · <Position> · <Organisation>` —
     e.g. `Viladwany Svastisin 20005109 · Head of Human Resources · CFG Human Resources`.
     The initials badge beside each row is `aria-hidden` and is **not** part
     of the name.
   - thirty people are listed before any search, with the note
     *"You only see what each role may access."*

4. **Pick the person.** Click their row button. There is no confirm step and
   no Save button — the click is the switch. The only other button in the
   dialog is its close control, whose accessible name is `ปิด` (Thai, even on
   the `/en/` locale).

5. **Prove the switch took** before doing anything the new persona is for.
   Re-read the account menu button: its initials change to the person now
   being acted for. Assert that, or assert a control the previous persona
   could not see.

## The trap in step 4 — read this before authoring a search

**The search box does not search by role, whatever its placeholder says.**
Measured on the live page, same session:

| Typed | Result |
|---|---|
| `Viladwany` (name) | 1 match |
| `20005109` (employee id) | 1 match |
| `HRBP` (role) | **"No employees match that search."** |
| `Human Resources` (role) | **"No employees match that search."** |

So a flow may fill that box **only** with a full name or an employee id that
the test case itself supplies. Filling it with a role phrase empties the list
and the case dead-ends on a page that is working correctly.

When the case names no person — only a role like `<HRBP_ACCOUNT>` — do not
search at all. Leave the list unfiltered and pick from it, because the role is
readable in each row's own name and nowhere else. A `workflow` step is the
honest way to author that choice: which listed person satisfies "HRBP" is a
judgement about thirty rows, not a selector.

## What to author

When the case names the person or their employee id:

```json
{ "action": "click", "selector": "role=button[name=\"Account menu\" i]",
  "intent": "Open the account menu to act on behalf of <PERSONA>." }
{ "action": "click", "selector": "role=menuitem[name=\"Take Action on Behalf of…\" i]",
  "intent": "Open the picker." }
{ "action": "fill",  "selector": "role=dialog >> role=textbox", "value": "<name or employee id>",
  "intent": "Narrow the list to the person the case names." }
{ "action": "click", "selector": "role=dialog >> text=\"<name or employee id>\"",
  "intent": "Act on behalf of <PERSONA>." }
```

When the case names only a role, replace the last two steps with one
`workflow` whose goal states the role, the dialog it is already looking at,
and that the choice is made by reading each row's position text — and that it
must not type a role phrase into the search box.

## Two things this must never become

- **Never a `signOut` + `signIn`.** That is the behaviour this replaces. It
  costs a login, loses the session the suite banked, and on HUMI lands back on
  the sign-in page, where an agent given the page will try to sign itself in.
- **Never a guess at a person.** If the case names no person and the list
  offers no row whose position matches the role, the correct outcome is a
  failure that says so. Acting on behalf of the wrong person produces a green
  case that proves nothing about the role it claimed to test.
