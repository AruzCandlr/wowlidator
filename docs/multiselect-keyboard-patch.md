# Proposed app patch — keyboard support for `MultiSelect`

Target: `cnext-hrms-fortest/src/components/cnext/molecules/MultiSelect.tsx`
Found: 2026-08-25, be100 campaign. Status: **draft — not applied**; the app repo
is not this repo's to change.

## The finding

The Create Plan modal's Company / Condition pickers use `MultiSelect`. Its ARIA
*vocabulary* is right — the trigger declares `aria-haspopup="listbox"`, the
panel renders a real `role="listbox" aria-multiselectable` with `role="option"`
items — but the options are **mouse-only**:

- no `onKeyDown` on the list or the options;
- options are not focusable (no `tabIndex`), and nothing manages an active
  option;
- selection happens only in each option's `onClick` (with `onMouseDown`
  preventDefault-ed).

So a keyboard user can open the popup (the trigger handles Enter/Space/Arrow)
and then cannot select anything — a WCAG 2.1.1 (Keyboard) failure. It is also
exactly why wowlidator's navigation agent stalls on PL_06 create-plan cases:
the widget *announces* the listbox pattern, the agent answers with the listbox
pattern's keys, and the widget ignores them. Three different agent models
(Gemini, GPT-OSS, GLM) all ended in `repeated press …` stalls on this control —
the announcement and the behavior disagree, and anything that trusts the
announcement loses.

## The fix (combobox-with-listbox pattern, matching `custom-select.tsx`)

Focus already lands on the search `<input>` (`autoFocus`). Drive the list from
there with an active-option index and `aria-activedescendant` — no focus moves,
~30 lines:

```tsx
// state, next to `open`/`query`:
const [active, setActive] = useState(0);
const optionId = (i: number) => `${id}-opt-${i}`;
useEffect(() => setActive(0), [query, open]);

// on the search <input>:
aria-activedescendant={filtered.length > 0 ? optionId(active) : undefined}
aria-controls={`${id}-listbox`}
role="combobox"
aria-expanded={open}
onKeyDown={(e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
  if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
  if (e.key === 'Enter' && filtered[active]) {
    e.preventDefault();
    const opt = filtered[active];
    const blocked = !selectedSet.has(opt.value) && atMax;
    if (!blocked) toggle(opt.value);      // stays open — it is a multi-select
  }
  if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
}}

// on the <ul>:
id={`${id}-listbox`}

// on each option <li> (inside filtered.map, using the map index):
id={optionId(index)}
className={cn(…existing…, index === active && 'bg-accent-tint')}
onMouseMove={() => setActive(index)}
```

Notes for the reviewer:

- Enter **toggles and keeps the popup open** — closing on first pick would make
  multi-pick a reopen loop; Escape closes and returns focus to the trigger,
  which is the pattern's close affordance.
- `aria-activedescendant` on the focused input (not roving tabIndex) keeps the
  search-as-you-type behavior intact — this is the same shape
  `custom-select.tsx` already uses for its single-select.
- The "Select all" button stays outside the listbox and keyboard-reachable by
  Tab, unchanged — its placement comment already explains why.
- After this lands, re-run the be100 PL_06 create-plan cases: the agent stalls
  on this widget should convert to real verdicts, and a screen-reader user
  gains a working picker for free.
