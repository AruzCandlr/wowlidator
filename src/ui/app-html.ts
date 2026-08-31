/**
 * The control panel page: markup, styles and behaviour, rendered as one
 * document.
 *
 * Same choice `html-reporter.ts` makes and for a related reason — a single
 * self-contained page has no asset paths to resolve, which means it works
 * identically when run from `src/` under tsx and from `dist/` after a build,
 * with `tsc` copying nothing but TypeScript.
 *
 * The client script builds DOM through `el()` rather than assembling HTML
 * strings. Everything it displays — file paths, model reasoning, application
 * text quoted back by a failing step — comes from somewhere else, and
 * `textContent` cannot be talked into executing any of it. The one exception is
 * the manual, which is our own static content and is documented as such.
 */

import { MANUAL } from './manual.js';
import { GRIM_BASE, GRIM_COMPONENTS, GRIM_TOKENS } from '../reporter/theme.js';

const STYLE = `
${GRIM_TOKENS}
${GRIM_BASE}
${GRIM_COMPONENTS}
/* The panel is a full-height app shell, unlike the report which is a document. */
html, body { height: 100%; }

#app { display: grid; grid-template-columns: 248px 1fr; height: 100vh; }

/* ---- sidebar ---- */
.side {
  background: var(--panel); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; overflow: hidden;
}
.brand { padding: 18px 18px 12px; border-bottom: 1px solid var(--line); }
.brand b { font-size: 19px; letter-spacing: -.02em; }
.brand span { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
.nav { flex: 1; overflow-y: auto; padding: 10px 10px 20px; }
.nav h4 {
  margin: 16px 8px 6px; font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--muted); font-weight: 600;
}
.nav button {
  display: block; width: 100%; text-align: left; border: 0; background: none;
  color: inherit; font: inherit; padding: 7px 10px; border-radius: 7px; cursor: pointer;
}
.nav button:hover { background: var(--bg); }
.nav button.on { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
/* One line per path, ellipsised, full value on hover — the nav must not have
   to be scrolled past a wall of absolute paths to reach the Manual. */
.paths { border-top: 1px solid var(--line); padding: 9px 14px 12px; font-size: 11px; color: var(--muted); flex: none; }
.paths div { margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.paths b { color: var(--ink); font-weight: 600; }

/* ---- main ---- */
.main { display: flex; flex-direction: column; overflow: hidden; }
.topbar {
  padding: 16px 26px 14px; border-bottom: 1px solid var(--line); background: var(--panel);
  display: flex; align-items: flex-start; gap: 18px; flex-wrap: wrap;
}
.topbar h1 { margin: 0; font-size: 20px; letter-spacing: -.01em; }
.topbar p { margin: 3px 0 0; color: var(--muted); font-size: 13.5px; max-width: 70ch; }
.chips { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.chip {
  font-size: 11.5px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted); background: var(--bg); white-space: nowrap;
}
.chip.good { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
.view { flex: 1; overflow-y: auto; padding: 22px 26px 60px; }
.view > * { max-width: 900px; }

/* ---- forms ---- */
.field { margin-bottom: 16px; }
.field > label { display: block; font-weight: 600; font-size: 13.5px; margin-bottom: 5px; }
.field .help { font-size: 12.5px; color: var(--muted); margin-top: 5px; }
input[type=text], input[type=number], textarea, select {
  width: 100%; padding: 8px 11px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--ink); font: inherit;
}
input[type=text]:focus, input[type=number]:focus, textarea:focus, select:focus {
  outline: 2px solid var(--accent-soft); border-color: var(--accent);
}
textarea { min-height: 76px; resize: vertical; }
.check { display: flex; gap: 9px; align-items: flex-start; }
.check input { margin-top: 4px; width: 16px; height: 16px; flex: none; }
.check label { font-weight: 600; font-size: 13.5px; }
details.more {
  border: 1px solid var(--line); border-radius: 10px; padding: 0 14px; margin: 18px 0;
  background: var(--panel);
}
details.more > summary {
  cursor: pointer; padding: 11px 0; font-weight: 600; font-size: 13.5px; list-style: none;
}
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "▸ "; color: var(--muted); }
details.more[open] > summary::before { content: "▾ "; }
details.more > div { padding-bottom: 8px; }

button.go, button.ghost {
  font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent;
}
button.go { background: var(--accent-strong); color: var(--on-accent); }
button.go:hover { filter: brightness(1.08); }
button.go:disabled { opacity: .5; cursor: not-allowed; }
button.ghost { background: var(--panel); color: var(--ink); border-color: var(--line); }
button.ghost:hover { background: var(--bg); }
button.tiny { font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
button.tiny:hover { background: var(--accent-soft); border-color: var(--accent); }
.actions { display: flex; gap: 10px; align-items: center; margin-top: 6px; }

.banner {
  border: 1px solid var(--line); border-left: 3px solid var(--warn); background: var(--panel);
  border-radius: 8px; padding: 11px 14px; margin-bottom: 18px; font-size: 13.5px;
}
.banner.err { border-left-color: var(--bad); }
.banner b { color: var(--warn); }
.banner.err b { color: var(--bad); }

/* ---- tables ---- */
table.data { width: 100%; border-collapse: collapse; font-size: 13.5px; }
table.data th {
  text-align: left; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--muted); padding: 6px 10px; border-bottom: 1px solid var(--line);
}
table.data td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.data tr:hover td { background: var(--panel); }
.pathcell { font-family: var(--mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 26px 0; }

/* ---- status ---- */
.pill {
  display: inline-block; font-size: 11.5px; font-weight: 700; padding: 2px 9px;
  border-radius: 999px; letter-spacing: .02em;
}
.pill.running { background: var(--accent-soft); color: var(--accent-ink); }
.pill.passed { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.pill.failed, .pill.error { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
.pill.stopped { background: var(--code-bg); color: var(--muted); }

/* ---- console ---- */
.console {
  border-top: 1px solid var(--line); background: var(--panel);
  display: flex; flex-direction: column; height: 42vh; min-height: 44px;
}
.console.closed { height: 44px; }
.console-head {
  display: flex; align-items: center; gap: 12px; padding: 0 18px; height: 44px;
  border-bottom: 1px solid var(--line); flex: none;
}
.console-head .cmd {
  font-family: var(--mono); font-size: 12px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
}
.console-body {
  flex: 1; overflow: auto; padding: 12px 18px; font-family: var(--mono);
  font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
}
.console.closed .console-body, .console.closed .arts { display: none; }
.console-body .e { color: var(--bad); }
.arts { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 18px 12px; flex: none; }

/* ---- viewer overlay ---- */
.overlay {
  position: fixed; inset: 0; background: rgba(9,11,15,.6); display: flex;
  flex-direction: column; padding: 26px; z-index: 50;
}
.overlay .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
.overlay .bar span { color: #fff; font-family: var(--mono); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.overlay iframe { flex: 1; border: 0; border-radius: 10px; background: #fff; }

/* ---- manual ---- */
.manual { display: grid; grid-template-columns: 200px 1fr; gap: 30px; max-width: 1040px; }
.manual .toc { position: sticky; top: 0; align-self: start; font-size: 13px; }
.manual .toc a { display: block; padding: 4px 0; color: var(--muted); text-decoration: none; }
.manual .toc a:hover { color: var(--accent); }
.manual section { margin-bottom: 34px; scroll-margin-top: 12px; }
.manual h2 { font-size: 17px; margin: 0 0 10px; letter-spacing: -.01em; }
.manual h3 { font-size: 14px; margin: 20px 0 7px; }
.manual p, .manual li { font-size: 14px; }
.manual .lead { font-size: 15px; }
.manual code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
.manual pre {
  background: var(--code-bg); padding: 12px 14px; border-radius: 9px; overflow-x: auto;
  font-size: 12.5px; line-height: 1.5;
}
.manual pre code { background: none; padding: 0; }
.manual table.ref { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13.5px; }
.manual table.ref th { text-align: left; font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--muted); padding: 5px 9px; border-bottom: 1px solid var(--line); }
.manual table.ref td { padding: 7px 9px; border-bottom: 1px solid var(--line); vertical-align: top; }
.manual table.ref.small td { font-size: 13px; }
.manual .tab-ref {
  background: var(--accent-soft); color: var(--accent-ink); padding: 1px 7px;
  border-radius: 5px; font-weight: 600; font-size: 12.5px; white-space: nowrap;
}
.manual ol.steps, .manual ol.ladder, .manual ul.split { padding-left: 22px; }
.manual ol.steps li, .manual ol.ladder li, .manual ul.split li { margin-bottom: 7px; }
.manual .muted { color: var(--muted); font-size: 12px; }

@media (max-width: 900px) {
  #app { grid-template-columns: 1fr; }
  .side { display: none; }
  .manual { grid-template-columns: 1fr; }
  .manual .toc { display: none; }
}
`;

const SCRIPT = String.raw`
'use strict';

var state = { meta: null, view: null, flows: [], job: null, es: null, prefill: null };

function el(tag, props, children) {
  var node = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'trustedHtml') node.innerHTML = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
  }
  (children || []).forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function byId(id) { return document.getElementById(id); }

function api(path, options) {
  return fetch(path, options).then(function (r) {
    return r.json().then(function (body) {
      if (!r.ok) throw new Error(body && body.error ? body.error : 'request failed');
      return body;
    });
  });
}

/* ---------------------------------------------------------------- navigation */

var BROWSE = [
  { id: 'flows', title: 'Flows', blurb: 'Every .flow.json wowlidator can see. Edit one, save it, run it.' },
  { id: 'reports', title: 'Reports', blurb: 'Every report rendered so far, newest first.' },
  { id: 'history', title: 'History', blurb: 'Is this newly broken, or has it been broken for a week?' },
  { id: 'cache', title: 'Healed selectors', blurb: 'Repairs the healer has cached, and what they cost to relearn.' },
  { id: 'runs', title: 'Runs', blurb: 'Everything this panel has started since it was launched.' },
  { id: 'manual', title: 'Manual', blurb: 'What all of this is, and how to use it.' }
];

function commandSpec(id) {
  return state.meta.commands.filter(function (c) { return c.id === id; })[0];
}

function renderSidebar() {
  var nav = byId('nav');
  clear(nav);

  function group(title, items) {
    nav.appendChild(el('h4', { text: title }));
    items.forEach(function (item) {
      nav.appendChild(el('button', {
        class: state.view === item.id ? 'on' : '',
        'data-nav': item.id,
        text: item.title,
        onclick: function () { show(item.id); }
      }));
    });
  }

  group('Test', ['go', 'run', 'generate', 'author', 'crawl', 'watch'].map(commandSpec));
  group('Set up', ['doctor', 'context-build', 'context-show'].map(commandSpec));
  group('Browse', BROWSE);

  // The other surface on this same server: the same commands and the same
  // artefacts, arranged around runs and their evidence instead of around forms.
  nav.appendChild(el('h4', { text: 'Elsewhere' }));
  nav.appendChild(el('button', {
    text: 'wowUI',
    title: 'runs, verdicts and the proof behind each step',
    onclick: function () { location.href = '/wow'; }
  }));

  var p = byId('paths');
  clear(p);
  var paths = state.meta.paths;
  [['here', state.meta.cwd], ['reports', paths.reportDir], ['proofs', paths.proofDir],
   ['cache', paths.cachePath], ['CDP', state.meta.cdpUrl]].forEach(function (row) {
    p.appendChild(el('div', { title: row[1] }, [el('b', { text: row[0] + ' ' }), shortPath(row[1])]));
  });
}

/** The tail of a path is the part that identifies it; the prefix is noise. */
function shortPath(value) {
  if (value.length < 30) return value;
  var parts = value.split('/');
  return parts.length < 3 ? value : '…/' + parts.slice(-2).join('/');
}

function show(viewId, prefill) {
  state.view = viewId;
  state.prefill = prefill || null;
  location.hash = viewId;
  Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (b) {
    b.className = b.getAttribute('data-nav') === viewId ? 'on' : '';
  });

  var spec = commandSpec(viewId);
  var browse = BROWSE.filter(function (b) { return b.id === viewId; })[0];
  var meta = spec || browse;
  byId('title').textContent = meta ? meta.title : viewId;
  byId('blurb').textContent = meta ? meta.blurb : '';

  var view = byId('view');
  clear(view);
  if (spec) renderCommand(view, spec);
  else if (viewId === 'flows') renderFlows(view);
  else if (viewId === 'reports') renderReports(view);
  else if (viewId === 'history') renderHistory(view);
  else if (viewId === 'cache') renderCache(view);
  else if (viewId === 'runs') renderRuns(view);
  else if (viewId === 'manual') renderManual(view);
}

/* ------------------------------------------------------------ command forms */

/* Show or hide every field gated on this toggle. Local to the two controls
   involved — no re-render, so nothing already typed is lost. */
function syncGated(name, on) {
  var all = document.querySelectorAll('[data-gated-by="' + name + '"]');
  for (var i = 0; i < all.length; i += 1) all[i].style.display = on ? '' : 'none';
}

function renderField(field, prefill) {
  var value = prefill && prefill[field.name] !== undefined ? prefill[field.name] : field['default'];

  if (field.type === 'boolean') {
    var box = el('input', { type: 'checkbox', id: 'f-' + field.name, name: field.name });
    box.checked = value === true;
    /* A field required only when this toggle is on appears only when it is
       on: asking for a database URL of a run that does not touch the database
       is a question with no right answer. */
    box.addEventListener('change', function () { syncGated(field.name, box.checked); });
    return el('div', { class: 'field' }, [
      el('div', { class: 'check' }, [
        box,
        el('div', {}, [
          el('label', { 'for': 'f-' + field.name, text: field.label }),
          el('div', { class: 'help', text: field.help })
        ])
      ])
    ]);
  }

  var input;
  if (field.type === 'enum') {
    input = el('select', { id: 'f-' + field.name, name: field.name },
      (field.choices || []).map(function (choice) {
        return el('option', { value: choice, text: choice, selected: choice === value });
      }));
  } else if (field.type === 'textarea') {
    input = el('textarea', {
      id: 'f-' + field.name, name: field.name, placeholder: field.placeholder || '', rows: '3'
    });
    if (value !== undefined) input.value = value;
  } else {
    input = el('input', {
      /* A secret renders as a password box: the value must not sit readable on
         screen, in a screenshot of the panel, or in the DOM as plain text. */
      type: field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text',
      id: 'f-' + field.name, name: field.name, placeholder: field.placeholder || '',
      min: field.min !== undefined ? String(field.min) : null,
      list: (field.name === 'flow' || field.name === 'target') ? 'flowlist' : null
    });
    if (value !== undefined) input.value = value;
  }

  var wrap = el('div', { class: 'field' }, [
    el('label', { 'for': 'f-' + field.name,
      text: field.label + (field.required || field.requiredWhen ? ' *' : '') }),
    input,
    el('div', { class: 'help', text: field.help })
  ]);
  /* Gated on a toggle: tagged so that toggle can show and hide it, and
     hidden to start unless the toggle's own default is on. */
  if (field.requiredWhen) {
    wrap.setAttribute('data-gated-by', field.requiredWhen.field);
    var gateOn = prefill && prefill[field.requiredWhen.field] !== undefined
      ? prefill[field.requiredWhen.field] === true
      : false;
    if (!gateOn) wrap.style.display = 'none';
  }
  return wrap;
}

function renderCommand(view, spec) {
  var missing = (spec.roles || []).map(function (role) {
    return state.meta.roles.filter(function (r) { return r.role === role; })[0];
  }).filter(function (r) { return r && !r.keyed; });

  if (missing.length > 0) {
    view.appendChild(el('div', { class: 'banner' }, [
      el('b', { text: 'Needs a model key. ' }),
      'The ' + missing.map(function (r) { return r.role; }).join(' and ') +
        ' role has no key — set ' + missing.map(function (r) { return r.envKey; }).join(' and ') +
        ' in .env. ',
      el('a', { href: missing[0].consoleUrl, target: '_blank', rel: 'noreferrer',
        text: 'Get one' }),
      '. Then check it with ',
      el('button', { class: 'tiny', text: 'Doctor', onclick: function () { show('doctor'); } }),
      '.'
    ]));
  }

  var form = el('form', { id: 'cmdform', onsubmit: function (e) { e.preventDefault(); submit(spec); } });
  var advanced = [];

  spec.fields.forEach(function (field) {
    if (field.advanced) advanced.push(field);
    else form.appendChild(renderField(field, state.prefill));
  });

  if (advanced.length > 0) {
    var box = el('div', {});
    advanced.forEach(function (field) { box.appendChild(renderField(field, state.prefill)); });
    form.appendChild(el('details', { class: 'more' }, [
      el('summary', { text: 'More options (' + advanced.length + ')' }), box
    ]));
  }

  form.appendChild(el('div', { class: 'actions' }, [
    el('button', { class: 'go', type: 'submit', text: spec.longRunning ? 'Start watching' : 'Run' }),
    el('span', { id: 'formerr', class: 'help' })
  ]));

  view.appendChild(form);
  view.appendChild(el('datalist', { id: 'flowlist' }, state.flows.map(function (f) {
    return el('option', { value: f.path });
  })));

  if (state.prefill && state.prefill.__autorun) submit(spec);
}

function submit(spec) {
  var form = byId('cmdform');
  var values = {};
  spec.fields.forEach(function (field) {
    var input = form.elements[field.name];
    if (!input) return;
    /* A boolean with an offFlag states its choice in BOTH directions — the
       CLI option is on by default and unchecking must actually say so. Every
       other boolean keeps sending nothing when off: absent means "not
       stated", which is what every command predating offFlag expects. */
    if (field.type === 'boolean') {
      if (input.checked) values[field.name] = true;
      else if (field.offFlag) values[field.name] = false;
    }
    else if (String(input.value).trim() !== '') values[field.name] = String(input.value).trim();
  });

  var err = byId('formerr');
  err.textContent = '';
  err.style.color = '';

  api('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: spec.id, values: values })
  }).then(function (body) {
    attach(body.job);
  })['catch'](function (error) {
    err.style.color = 'var(--bad)';
    err.textContent = error.message;
  });
}

/* ----------------------------------------------------------------- console */

function attach(job) {
  state.job = job;
  if (state.es) { state.es.close(); state.es = null; }

  byId('console').className = 'console';
  byId('con-cmd').textContent = job.commandLine;
  setStatus(job.status, null);
  var body = byId('con-body');
  clear(body);
  clear(byId('con-arts'));

  var es = new EventSource('/api/jobs/' + encodeURIComponent(job.id) + '/events');
  state.es = es;
  es.addEventListener('replay', function (event) {
    var data = JSON.parse(event.data);
    clear(body);
    data.lines.forEach(appendLine);
    data.artifacts.forEach(addArtifact);
    setStatus(data.status, null);
  });
  es.addEventListener('line', function (event) { appendLine(JSON.parse(event.data)); });
  es.addEventListener('artifact', function (event) { addArtifact(JSON.parse(event.data)); });
  es.addEventListener('done', function (event) {
    var data = JSON.parse(event.data);
    setStatus(data.status, data.exitCode);
    es.close();
    state.es = null;
    if (state.view === 'flows' || state.view === 'reports') show(state.view);
  });
}

function appendLine(line) {
  var body = byId('con-body');
  var stuck = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
  body.appendChild(el('div', { class: line.stream === 'err' ? 'e' : '', text: line.text || ' ' }));
  if (stuck) body.scrollTop = body.scrollHeight;
}

function setStatus(status, code) {
  var pill = byId('con-status');
  pill.className = 'pill ' + status;
  pill.textContent = status === 'running' ? 'running'
    : status + (code !== null && code !== undefined ? ' (exit ' + code + ')' : '');
  byId('con-stop').style.display = status === 'running' ? '' : 'none';
}

function addArtifact(artifact) {
  var label = artifact.kind + ' · ' + artifact.path.split('/').pop();
  byId('con-arts').appendChild(el('button', {
    class: 'tiny', title: artifact.path, text: label,
    onclick: function () { openArtifact(artifact); }
  }));
}

function openArtifact(artifact) {
  if (/\.html$/.test(artifact.path)) { openViewer(artifact.path); return; }
  if (/\.flow\.json$/.test(artifact.path)) { show('flows'); setTimeout(function () { editFlow(artifact.path); }, 80); return; }
  navigator.clipboard.writeText(artifact.path);
  byId('con-cmd').textContent = 'copied: ' + artifact.path;
}

function openViewer(path) {
  var frame = el('iframe', { src: '/view?path=' + encodeURIComponent(path) });
  var overlay = el('div', { class: 'overlay' }, [
    el('div', { class: 'bar' }, [
      el('span', { text: path }),
      el('button', { class: 'tiny', text: 'Open in a tab', onclick: function () {
        window.open('/view?path=' + encodeURIComponent(path), '_blank');
      } }),
      el('button', { class: 'tiny', text: 'Close', onclick: function () { overlay.remove(); } })
    ]),
    frame
  ]);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

/* ------------------------------------------------------------------ browse */

function loadFlows() {
  return api('/api/flows').then(function (body) { state.flows = body.flows; return body.flows; });
}

function renderFlows(view) {
  view.appendChild(el('div', { class: 'empty', text: 'looking…' }));
  loadFlows().then(function (flows) {
    clear(view);
    if (flows.length === 0) {
      view.appendChild(el('div', { class: 'empty' }, [
        'No .flow.json files found yet. Write one with ',
        el('button', { class: 'tiny', text: 'Generate tests', onclick: function () { show('generate'); } }),
        ' or ',
        el('button', { class: 'tiny', text: 'Author one test', onclick: function () { show('author'); } }),
        '.'
      ]));
      return;
    }
    var rows = flows.map(function (flow) {
      return el('tr', {}, [
        el('td', {}, [
          el('div', { text: flow.name }),
          el('div', { class: 'pathcell', text: flow.path }),
          !flow.valid ? el('div', { class: 'pathcell', style: 'color:var(--bad)',
            text: 'not a valid flow — needs "name" and "steps"' }) : null
        ]),
        el('td', { text: flow.steps ? String(flow.steps) : '—' }),
        el('td', { class: 'pathcell', text: flow.modified ? flow.modified.slice(0, 16).replace('T', ' ') : '' }),
        el('td', {}, [
          el('button', { class: 'tiny', text: 'Run', onclick: function () {
            show('run', { flow: flow.path, __autorun: true });
          } }),
          ' ',
          el('button', { class: 'tiny', text: 'Edit', onclick: function () { editFlow(flow.path); } })
        ])
      ]);
    });
    view.appendChild(el('table', { class: 'data' }, [
      el('tr', {}, [el('th', { text: 'Flow' }), el('th', { text: 'Steps' }),
        el('th', { text: 'Modified' }), el('th', { text: '' })])
    ].concat(rows)));
  });
}

function editFlow(path) {
  var view = byId('view');
  clear(view);
  byId('title').textContent = 'Edit flow';
  byId('blurb').textContent = path;

  api('/api/file?path=' + encodeURIComponent(path)).then(function (body) {
    var area = el('textarea', { style: 'min-height:52vh', spellcheck: 'false', class: 'mono' });
    area.value = body.content;
    var status = el('span', { class: 'help' });

    view.appendChild(el('div', { class: 'field' }, [area]));
    view.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'go', text: 'Save', onclick: function () {
        api('/api/file?path=' + encodeURIComponent(path), {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: area.value })
        }).then(function () {
          status.style.color = 'var(--ok)';
          status.textContent = 'saved';
        })['catch'](function (error) {
          status.style.color = 'var(--bad)';
          status.textContent = error.message;
        });
      } }),
      el('button', { class: 'ghost', text: 'Save and run', onclick: function () {
        api('/api/file?path=' + encodeURIComponent(path), {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: area.value })
        }).then(function () { show('run', { flow: path, __autorun: true }); })
          ['catch'](function (error) {
            status.style.color = 'var(--bad)';
            status.textContent = error.message;
          });
      } }),
      el('button', { class: 'ghost', text: 'Back', onclick: function () { show('flows'); } }),
      status
    ]));
  })['catch'](function (error) {
    view.appendChild(el('div', { class: 'banner err' }, [el('b', { text: 'Could not open. ' }), error.message]));
  });
}

function renderReports(view) {
  view.appendChild(el('div', { class: 'empty', text: 'looking…' }));
  api('/api/reports').then(function (body) {
    clear(view);
    if (body.reports.length === 0) {
      view.appendChild(el('div', { class: 'empty', text: 'No reports yet. Run something and one appears here.' }));
      return;
    }
    var rows = body.reports.map(function (report) {
      return el('tr', {}, [
        el('td', {}, [
          el('div', { text: report.name }),
          el('div', { class: 'pathcell', text: report.path })
        ]),
        el('td', { class: 'pathcell', text: report.modified.slice(0, 16).replace('T', ' ') }),
        el('td', { class: 'pathcell', text: Math.round(report.size / 1024) + ' KB' }),
        el('td', {}, [el('button', { class: 'tiny', text: 'Open', onclick: function () { openViewer(report.path); } })])
      ]);
    });
    view.appendChild(el('table', { class: 'data' }, [
      el('tr', {}, [el('th', { text: 'Report' }), el('th', { text: 'Rendered' }),
        el('th', { text: 'Size' }), el('th', { text: '' })])
    ].concat(rows)));
  });
}

function renderHistory(view) {
  view.appendChild(el('div', { class: 'empty', text: 'reading…' }));
  api('/api/history').then(function (body) {
    clear(view);
    if (body.entries.length === 0) {
      view.appendChild(el('div', { class: 'empty' }, [
        'No history yet. Every run appends one line to ',
        el('code', { text: state.meta.paths.historyPath }), '.'
      ]));
      return;
    }
    view.appendChild(el('p', { class: 'help', text: body.total + ' run(s) recorded; showing the most recent ' + body.entries.length + '.' }));
    var rows = body.entries.map(function (entry) {
      return el('tr', {}, [
        el('td', {}, [el('span', { class: 'pill ' + (entry.status === 'passed' ? 'passed' : 'failed'), text: entry.status })]),
        el('td', { text: entry.name }),
        el('td', { class: 'pathcell', text: String(entry.finishedAt || '').slice(0, 16).replace('T', ' ') }),
        el('td', { text: entry.passed + ' / ' + (entry.passed + entry.failed) }),
        el('td', { text: entry.jitHeals ? String(entry.jitHeals) : '—' }),
        el('td', { text: entry.defects ? String(entry.defects) : '—' }),
        el('td', { text: entry.durationMs ? Math.round(entry.durationMs / 100) / 10 + 's' : '' })
      ]);
    });
    view.appendChild(el('table', { class: 'data' }, [
      el('tr', {}, ['', 'Flow', 'Finished', 'Steps passed', 'Heals', 'Defects', 'Took'].map(function (h) {
        return el('th', { text: h });
      }))
    ].concat(rows)));
  });
}

function renderCache(view) {
  view.appendChild(el('div', { class: 'empty', text: 'reading…' }));
  api('/api/cache').then(function (body) {
    clear(view);
    view.appendChild(el('p', { class: 'help' }, [
      'Cached repairs live in ', el('code', { text: body.path }),
      '. A cached selector that fails is deleted rather than retried — a stale repair is worse than none.'
    ]));
    if (body.entries.length === 0) {
      view.appendChild(el('div', { class: 'empty', text: 'Nothing cached. Either nothing has needed repairing, or healing is off.' }));
      return;
    }
    view.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'ghost', text: 'Forget everything', onclick: function () {
        show('cache-forget', { all: true, __autorun: true });
      } })
    ]));
    var rows = body.entries.map(function (entry) {
      return el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'pathcell', text: entry.key }),
          el('div', { class: 'mono', style: 'font-size:12px', text: '→ ' + entry.healed })
        ]),
        el('td', { text: entry.strategy || '' }),
        el('td', { text: entry.confidence !== undefined ? Number(entry.confidence).toFixed(2) : '' }),
        el('td', { text: entry.hits !== undefined ? String(entry.hits) : '' }),
        el('td', {}, [el('button', { class: 'tiny', text: 'Forget', onclick: function () {
          show('cache-forget', { key: entry.key, __autorun: true });
        } })])
      ]);
    });
    view.appendChild(el('table', { class: 'data' }, [
      el('tr', {}, ['Selector', 'Strategy', 'Confidence', 'Hits', ''].map(function (h) {
        return el('th', { text: h });
      }))
    ].concat(rows)));
  });
}

function renderRuns(view) {
  api('/api/jobs').then(function (body) {
    clear(view);
    if (body.jobs.length === 0) {
      view.appendChild(el('div', { class: 'empty', text: 'Nothing has been run from this panel yet.' }));
      return;
    }
    var rows = body.jobs.map(function (job) {
      return el('tr', {}, [
        el('td', {}, [el('span', { class: 'pill ' + job.status, text: job.status })]),
        el('td', {}, [
          el('div', { text: job.title }),
          el('div', { class: 'pathcell', text: job.commandLine })
        ]),
        el('td', { class: 'pathcell', text: job.startedAt.slice(11, 19) }),
        el('td', {}, [
          el('button', { class: 'tiny', text: 'Output', onclick: function () { attach(job); } }),
          ' ',
          job.status === 'running'
            ? el('button', { class: 'tiny', text: 'Stop', onclick: function () { stopJob(job.id); } })
            : null
        ])
      ]);
    });
    view.appendChild(el('table', { class: 'data' }, [
      el('tr', {}, ['', 'Command', 'Started', ''].map(function (h) { return el('th', { text: h }); }))
    ].concat(rows)));
  });
}

function stopJob(id) {
  api('/api/jobs/' + encodeURIComponent(id) + '/stop', { method: 'POST' }).then(function () {
    if (state.view === 'runs') show('runs');
  });
}

/* ------------------------------------------------------------------ manual */

function renderManual(view) {
  var wrap = el('div', { class: 'manual' });
  var toc = el('div', { class: 'toc' });
  var body = el('div', {});

  MANUAL.forEach(function (section) {
    toc.appendChild(el('a', { href: '#manual', text: section.title, onclick: function (e) {
      e.preventDefault();
      var target = byId('m-' + section.id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } }));
    // Static, authored content shipped with this file — the one place innerHTML
    // is used, and nothing user- or model-supplied reaches it.
    body.appendChild(el('section', { id: 'm-' + section.id }, [
      el('h2', { text: section.title }),
      el('div', { trustedHtml: section.html })
    ]));
  });

  wrap.appendChild(toc);
  wrap.appendChild(body);
  view.appendChild(wrap);
}

/* -------------------------------------------------------------------- boot */

function boot() {
  api('/api/meta').then(function (meta) {
    state.meta = meta;

    var keyed = meta.roles.filter(function (r) { return r.keyed; }).length;
    var chips = byId('chips');
    chips.appendChild(el('span', { class: 'chip', text: 'CDP ' + meta.cdpUrl.replace(/^https?:\/\//, '') }));
    chips.appendChild(el('span', {
      class: 'chip ' + (keyed === meta.roles.length ? 'good' : keyed === 0 ? 'bad' : ''),
      text: keyed + '/' + meta.roles.length + ' model roles keyed'
    }));

    renderSidebar();
    loadFlows()['catch'](function () { return []; }).then(function () {
      var initial = (location.hash || '').replace('#', '');
      var known = state.meta.commands.some(function (c) { return c.id === initial; }) ||
        BROWSE.some(function (b) { return b.id === initial; });
      show(known ? initial : 'go');
      renderSidebar();
    });
  })['catch'](function (error) {
    byId('view').appendChild(el('div', { class: 'banner err' }, [
      el('b', { text: 'Could not read the configuration. ' }), error.message
    ]));
  });

  byId('con-stop').addEventListener('click', function () {
    if (state.job) stopJob(state.job.id);
  });
  byId('con-toggle').addEventListener('click', function () {
    var c = byId('console');
    c.className = c.className.indexOf('closed') === -1 ? 'console closed' : 'console';
  });
  // Back, forward, and a pasted #tab link all mean the same thing here.
  window.addEventListener('hashchange', function () {
    var next = (location.hash || '').replace('#', '');
    if (next !== '' && next !== state.view) show(next);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var overlay = document.querySelector('.overlay');
      if (overlay) overlay.remove();
    }
  });
}

/* The usage-cap popup — the same one wowUI shows, on this surface too: once
   per trip, never auto-dismissed. Polled on the quota's own cadence; the
   server answer is cached, so this is cheap. */
var capPopupFor = null;
function pollUsageCap() {
  api('/api/usage-cap').then(function (cap) {
    if (!cap || !cap.tripped || capPopupFor === cap.tripped.at) return;
    capPopupFor = cap.tripped.at;
    var t = cap.tripped;
    var overlay = el('div', { style: 'position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:1000' });
    var box = el('div', { role: 'alertdialog', 'aria-label': 'Usage cap reached', style: 'background:var(--bg, #fff); color:inherit; max-width:520px; padding:20px 24px; border-radius:8px; box-shadow:0 8px 32px rgba(0,0,0,.3)' }, [
      el('h2', { text: 'Usage cap reached', style: 'margin:0 0 8px' }),
      el('p', { text: t.reason + ' — every running job was stopped' + (t.stoppedJobs.length ? ' (' + t.stoppedJobs.join(', ') + ')' : '') + ', and new runs are held until the cap is reset.' }),
      el('p', { text: (t.resetsAt ? 'The window resets at ' + new Date(t.resetsAt).toLocaleString() + '. ' : '') + 'Reset the hold, raise the cap, or turn it off on wowUI’s Models & keys page (/wow).' }),
      el('div', { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:12px' }, [
        el('a', { href: '/wow', text: 'Open wowUI' }),
        el('button', { type: 'button', text: 'Dismiss', onclick: function () { overlay.remove(); } })
      ])
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  })['catch'](function () {});
}
pollUsageCap();
setInterval(pollUsageCap, 30000);

boot();
`;

/**
 * The whole page.
 *
 * The manual is injected as data rather than fetched, so the Manual tab works
 * even if the server is mid-restart — and `<` is escaped because a document
 * containing the literal characters `</script>` inside a script tag ends the
 * script there, whatever the JSON around it says.
 */
export function renderApp(): string {
  const manualJson = JSON.stringify(MANUAL).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wowlidator — control panel</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app">
  <aside class="side">
    <div class="brand"><b>wowlidator</b><span>control panel</span></div>
    <nav class="nav" id="nav"></nav>
    <div class="paths" id="paths"></div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div>
        <h1 id="title">wowlidator</h1>
        <p id="blurb"></p>
      </div>
      <div class="chips" id="chips"></div>
    </header>
    <section class="view" id="view"></section>
    <section class="console closed" id="console">
      <div class="console-head">
        <button class="tiny" id="con-toggle" title="Show or hide the output">output</button>
        <span class="pill stopped" id="con-status">idle</span>
        <span class="cmd" id="con-cmd">nothing running</span>
        <button class="tiny" id="con-stop" style="display:none">Stop</button>
      </div>
      <div class="console-body" id="con-body"></div>
      <div class="arts" id="con-arts"></div>
    </section>
  </div>
</div>
<script>var MANUAL = ${manualJson};</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
