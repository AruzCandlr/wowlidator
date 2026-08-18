/**
 * Sequence diagrams as claims documents — deterministic, no model call.
 *
 * A `.mmd`/`.puml` diagram is participants and ordered messages, and both
 * notations are line-based text, so claims extraction is a parse, not a
 * reasoning job — the CSV table path's precedent (`test-case-table.ts`),
 * one notch up in structure. Each message becomes one claim; the person at
 * the gate prunes them exactly as they prune any other catalog.
 *
 * The boundary rule that shapes everything here: wowlidator sits in the browser,
 * so a message is verifiable exactly to the extent the browser can see it.
 * A message *sent by* the user or the page (and the replies back to them) is
 * observable — flow steps and the network observer cover those lanes. A
 * message between backend participants, or backend → database, is **not**,
 * and its claim is emitted `testable: false` with the boundary named in its
 * source — kept and shown, never silently dropped, never silently promoted
 * to a check that could not be honest.
 *
 * Scope, v1, disclosed: linear messages and `alt`/`else` (each branch labels
 * its claims, so authoring can split branches into separate cases) and `opt`
 * (a message that may or may not appear can never fail, so it is carried as
 * a note, not a claim). `loop`/`par`/`critical`/`break` are refused with a
 * note naming what was skipped — a refusal a person sees beats a guess
 * nobody can audit. Unrecognised lines land on the notes list for the same
 * reason.
 */

import type { CatalogClaim, ClaimsFile } from './catalog.js';

export type ParticipantPlane = 'user' | 'page' | 'backend' | 'external';

export interface SequenceParticipant {
  /** The identifier messages use. */
  id: string;
  /** Display label (`participant "Web App" as W`). */
  label: string;
  /** What the notation declared it as. */
  kind: string;
  /**
   * Which plane of the system it sits on — decides which lane a message is
   * on, and with it whether the message is verifiable from the browser.
   */
  plane: ParticipantPlane;
  /**
   * True when the plane is a heuristic default rather than something the
   * notation states (`actor` and `database` are stated; a `participant`
   * named "API" is a guess). Guesses are for the person at the gate to
   * confirm — they are written down, never silently acted on.
   */
  guessed: boolean;
}

export interface SequenceMessage {
  from: string;
  to: string;
  text: string;
  /** Dashed arrow — a reply/return message. */
  reply: boolean;
  /** 1-based line in the source, so the gate can trace every claim. */
  line: number;
  /** Set for messages inside an `alt` branch. */
  branch?: { group: number; label: string } | undefined;
}

export interface SequenceDoc {
  notation: 'mermaid' | 'plantuml';
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  /** Everything skipped, refused or ignored — surfaced, never logged away. */
  notes: string[];
  /**
   * How many lines the parser ignored, in full. The notes list caps its
   * per-line entries at MAX_IGNORED_NOTES, so a consumer judging "was most of
   * this diagram lost?" must read this counter, never count the notes — a
   * transcript with 8 noted lines and 50 more behind the overflow note would
   * otherwise read as barely-lossy.
   */
  ignored: number;
}

export class SequenceParseError extends Error {
  override readonly name = 'SequenceParseError';
  constructor(detail: string, line?: number) {
    super(`could not read the sequence diagram: ${detail}${line === undefined ? '' : ` (line ${line})`}`);
  }
}

/** Cheap content check — used by the extract arm to validate, not to sniff. */
export function looksLikeSequenceDiagram(text: string): 'mermaid' | 'plantuml' | null {
  if (/^\s*sequenceDiagram\b/m.test(text)) return 'mermaid';
  if (/@startuml\b/.test(text)) return 'plantuml';
  return null;
}

const UNSUPPORTED_BLOCKS = new Set(['loop', 'par', 'critical', 'break']);
const MAX_IGNORED_NOTES = 8;

interface BlockFrame {
  type: string;
  label: string;
  group: number;
  /** For unsupported blocks: how many messages were swallowed. */
  swallowed: number;
}

export function parseSequenceDiagram(text: string): SequenceDoc {
  const notation = looksLikeSequenceDiagram(text);
  if (notation === null) {
    throw new SequenceParseError(
      'neither a Mermaid `sequenceDiagram` header nor a PlantUML `@startuml` block was found',
    );
  }
  return notation === 'mermaid' ? parseMermaid(text) : parsePlantUml(text);
}

/** Shared line loop — the two grammars differ only in their matchers. */
function parseLines(
  notation: 'mermaid' | 'plantuml',
  lines: readonly string[],
  matchers: {
    skip: (line: string) => boolean;
    participant: (line: string) => { id: string; label: string; kind: string } | null;
    message: (line: string) => { from: string; to: string; text: string; reply: boolean } | null;
    blockOpen: (line: string) => { type: string; label: string } | null;
    blockElse: (line: string) => { label: string } | null;
    blockEnd: (line: string) => boolean;
  },
): SequenceDoc {
  const participants = new Map<string, SequenceParticipant>();
  const messages: SequenceMessage[] = [];
  const notes: string[] = [];
  const stack: BlockFrame[] = [];
  let altGroups = 0;
  let ignored = 0;

  const ensureParticipant = (id: string, kind = 'participant', label?: string): void => {
    if (participants.has(id)) return;
    participants.set(id, { id, label: label ?? id, kind, plane: 'backend', guessed: true });
  };

  const currentBranch = (): { group: number; label: string } | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i]!;
      if (frame.type === 'alt') return { group: frame.group, label: frame.label };
    }
    return undefined;
  };

  const insideUnsupported = (): BlockFrame | undefined =>
    stack.find((frame) => UNSUPPORTED_BLOCKS.has(frame.type));

  const insideOpt = (): boolean => stack.some((frame) => frame.type === 'opt');

  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineNo = index + 1;
    if (line === '' || matchers.skip(line)) return;

    const open = matchers.blockOpen(line);
    if (open) {
      altGroups += open.type === 'alt' ? 1 : 0;
      stack.push({ type: open.type, label: open.label, group: altGroups, swallowed: 0 });
      return;
    }
    const branch = matchers.blockElse(line);
    if (branch) {
      const top = stack[stack.length - 1];
      if (top && top.type === 'alt') top.label = branch.label;
      return;
    }
    if (matchers.blockEnd(line)) {
      const closed = stack.pop();
      if (closed && UNSUPPORTED_BLOCKS.has(closed.type) && closed.swallowed > 0) {
        notes.push(
          `${closed.type} block ending at line ${lineNo}: ${closed.swallowed} message(s) were not ` +
            `turned into claims — ${closed.type} is not supported yet`,
        );
      }
      return;
    }

    const participant = matchers.participant(line);
    if (participant) {
      participants.set(participant.id, {
        id: participant.id,
        label: participant.label,
        kind: participant.kind,
        plane: 'backend',
        guessed: true,
      });
      return;
    }

    const message = matchers.message(line);
    if (message) {
      const unsupported = insideUnsupported();
      if (unsupported) {
        unsupported.swallowed += 1;
        return;
      }
      ensureParticipant(message.from);
      ensureParticipant(message.to);
      if (insideOpt()) {
        notes.push(
          `line ${lineNo} (opt): "${message.text}" may or may not happen — a claim that cannot ` +
            'fail is not asserted',
        );
        return;
      }
      messages.push({
        from: message.from,
        to: message.to,
        text: message.text,
        reply: message.reply,
        line: lineNo,
        branch: currentBranch(),
      });
      return;
    }

    ignored += 1;
    if (ignored <= MAX_IGNORED_NOTES) notes.push(`line ${lineNo} ignored: ${line.slice(0, 60)}`);
  });

  if (ignored > MAX_IGNORED_NOTES) {
    notes.push(`…and ${ignored - MAX_IGNORED_NOTES} more line(s) ignored`);
  }
  if (messages.length === 0) {
    throw new SequenceParseError('the diagram contains no messages this parser could read');
  }

  const doc: SequenceDoc = {
    notation,
    participants: [...participants.values()],
    messages,
    notes,
    ignored,
  };
  classifyPlanes(doc);
  return doc;
}

// --- Mermaid ---------------------------------------------------------------

const MERMAID_SKIP =
  /^(sequenceDiagram\b|autonumber\b|title[\s:]|accTitle|accDescr|activate\s|deactivate\s|[Nn]ote\s|link\s|links\s|properties\s|%%)/;
const MERMAID_PARTICIPANT = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/;
const MERMAID_MESSAGE = /^(\S+?)\s*(--?)(>>|>|\)|x)([+-])?\s*([^\s:][^:]*?)\s*:\s*(.+)$/;
const MERMAID_BLOCK_OPEN = /^(alt|opt|loop|par|critical|break|rect|box)\b\s*(.*)$/;
const MERMAID_BLOCK_ELSE = /^(else|and|option)\b\s*(.*)$/;

function parseMermaid(text: string): SequenceDoc {
  return parseLines('mermaid', text.split('\n'), {
    skip: (line) => MERMAID_SKIP.test(line),
    participant: (line) => {
      const match = MERMAID_PARTICIPANT.exec(line);
      if (!match?.[2]) return null;
      return { id: match[2], label: match[3]?.trim() ?? match[2], kind: match[1] ?? 'participant' };
    },
    message: (line) => {
      const match = MERMAID_MESSAGE.exec(line);
      if (!match) return null;
      const [, from, dashes, , , to, messageText] = match;
      if (!from || !to || messageText === undefined) return null;
      return { from, to: to.trim(), text: messageText.trim(), reply: dashes === '--' };
    },
    blockOpen: (line) => {
      const match = MERMAID_BLOCK_OPEN.exec(line);
      if (!match?.[1]) return null;
      // `rect`/`box` are purely visual grouping — transparent, but they still
      // nest and carry an `end`, so they go on the stack like everything else.
      return { type: match[1], label: match[2]?.trim() ?? '' };
    },
    blockElse: (line) => {
      const match = MERMAID_BLOCK_ELSE.exec(line);
      return match ? { label: match[2]?.trim() ?? '' } : null;
    },
    blockEnd: (line) => /^end\b/.test(line),
  });
}

// --- PlantUML --------------------------------------------------------------

const PLANTUML_SKIP =
  /^(@startuml|@enduml|title[\s:]|autonumber\b|skinparam\b|hide\b|show\b|activate\s|deactivate\s|destroy\s|==.*==$|\.{3}|\|{2,}|'|\/')/;
const PLANTUML_PARTICIPANT =
  /^(participant|actor|database|boundary|control|entity|collections|queue)\s+(?:"([^"]+)"\s+as\s+(\S+)|(\S+?)(?:\s+as\s+"([^"]+)")?)\s*(?:#\S+)?$/;
const PLANTUML_MESSAGE =
  /^("[^"]+"|\S+?)\s*(--?)(>>|>|\\\\|\\|\/\/|\/)\s*("[^"]+"|\S+?)\s*:\s*(.+)$/;
const PLANTUML_BLOCK_OPEN = /^(alt|opt|loop|par|critical|break|group)\b\s*(.*)$/;
const PLANTUML_BLOCK_ELSE = /^(else)\b\s*(.*)$/;

function unquote(token: string): string {
  return token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
}

function parsePlantUml(text: string): SequenceDoc {
  // Multi-line notes (`note left ... end note`) are stripped before the line
  // loop — their bodies are prose, and prose lines would otherwise land in
  // the ignored list one by one.
  const withoutNotes = text.replace(/^[ \t]*[Nn]ote\b[^\n]*\n[\s\S]*?^[ \t]*end ?note[^\n]*$/gm, '');
  return parseLines('plantuml', withoutNotes.split('\n'), {
    skip: (line) => PLANTUML_SKIP.test(line) || /^[Nn]ote\b/.test(line),
    participant: (line) => {
      const match = PLANTUML_PARTICIPANT.exec(line);
      if (!match?.[1]) return null;
      const kind = match[1];
      if (match[2] && match[3]) return { id: match[3], label: match[2], kind };
      if (match[4]) return { id: match[4], label: match[5] ?? match[4], kind };
      return null;
    },
    message: (line) => {
      const match = PLANTUML_MESSAGE.exec(line);
      if (!match) return null;
      const [, from, dashes, , to, messageText] = match;
      if (!from || !to || messageText === undefined) return null;
      return {
        from: unquote(from),
        to: unquote(to),
        text: messageText.trim(),
        reply: dashes === '--',
      };
    },
    blockOpen: (line) => {
      const match = PLANTUML_BLOCK_OPEN.exec(line);
      if (!match?.[1]) return null;
      // `group` is PlantUML's generic frame — visual, transparent.
      return { type: match[1] === 'group' ? 'rect' : match[1], label: match[2]?.trim() ?? '' };
    },
    blockElse: (line) => {
      const match = PLANTUML_BLOCK_ELSE.exec(line);
      return match ? { label: match[2]?.trim() ?? '' } : null;
    },
    blockEnd: (line) => /^end\b/.test(line) && !/^end ?note\b/.test(line),
  });
}

// --- plane classification --------------------------------------------------

/**
 * A message is verifiable from the browser exactly when the browser can see
 * it: sent by the user (a flow step) or by the page (observed traffic), or a
 * reply coming back to either (the response on the same observed record).
 */
export function isObservable(doc: SequenceDoc, message: SequenceMessage): boolean {
  const byId = new Map(doc.participants.map((p) => [p.id, p]));
  const from = byId.get(message.from);
  const to = byId.get(message.to);
  if (!from || !to) return false;
  if (from.plane === 'user' || from.plane === 'page') return true;
  return message.reply && (to.plane === 'user' || to.plane === 'page');
}

/**
 * Messages → claims, deterministically — the model string callers show is
 * literally "read from the diagram (no model call)". Every message becomes
 * one claim; the unverifiable lanes come out `testable: false` with the
 * boundary named in `source`, which the authoring prompt then lists under
 * "assume this is already true" — kept and shown, never checked, never
 * silently dropped.
 */
export function sequenceToClaims(doc: SequenceDoc): { summary: string; claims: CatalogClaim[] } {
  const byId = new Map(doc.participants.map((p) => [p.id, p]));
  const labelOf = (id: string): string => byId.get(id)?.label ?? id;
  const planeOf = (id: string): ParticipantPlane => byId.get(id)?.plane ?? 'backend';

  const claims: CatalogClaim[] = doc.messages.map((message) => {
    const observable = isObservable(doc, message);
    const branch = message.branch ? ` [alt: ${message.branch.label || `branch ${message.branch.group}`}]` : '';
    const boundary = observable
      ? ''
      : ` (beyond the browser boundary: ${planeOf(message.from)} → ${planeOf(message.to)} — held as an assumption)`;
    return {
      claim: `${labelOf(message.from)} → ${labelOf(message.to)}: ${message.text}`,
      priority: 'medium',
      source: `line ${message.line}${branch}${boundary}`,
      testable: observable,
    };
  });

  const branches = new Set(doc.messages.map((m) => m.branch?.group).filter((g) => g !== undefined));
  const summary =
    `Sequence diagram (${doc.notation}): ${doc.participants.length} participant(s), ` +
    `${doc.messages.length} message(s)` +
    (branches.size > 0 ? `, ${branches.size} alt fork(s) — each branch is its own case` : '');

  return { summary, claims };
}

/**
 * The gate's machine-readable half: which claim came from which message, and
 * between whom. This is what lets wowUI's lane editor recompute a claim's
 * testability when a person corrects a guessed plane — the claims alone carry
 * only prose. `claim` indexes into the array `sequenceToClaims` returned,
 * which is 1:1 with `doc.messages` by construction.
 *
 * The observability rule is mirrored in the panel's client script
 * (`recomputeLanes` in `wow-ui-html.ts`) — it cannot import this module, so
 * a change to `isObservable` must change both.
 */
export function toGateInfo(doc: SequenceDoc): {
  notation: string;
  participants: Array<{ name: string; label: string; plane: string; guessed: boolean }>;
  messages: Array<{ claim: number; from: string; to: string; reply: boolean }>;
} {
  return {
    notation: doc.notation,
    participants: doc.participants.map((participant) => ({
      name: participant.id,
      label: participant.label,
      plane: participant.plane,
      guessed: participant.guessed,
    })),
    messages: doc.messages.map((message, index) => ({
      claim: index,
      from: message.from,
      to: message.to,
      reply: message.reply,
    })),
  };
}

const DB_NAME_RE = /\b(db|database|postgres|postgresql|mysql|mongo|mongodb|redis|store|storage)\b/i;
const PAGE_NAME_RE = /\b(browser|ui|web ?app|webapp|frontend|front-end|page|client|spa|app)\b/i;
const EXTERNAL_NAME_RE = /\b(mail|email|smtp|payment|stripe|gateway|third|external|queue|kafka|s3)\b/i;

const BOUNDARY_SUFFIX_RE = /\s*\(beyond the browser boundary:.*\)\s*$/;

/**
 * Re-derive every claim's `testable` from the claims file's own lane table —
 * the single semantics both gates share. wowUI's lane editor recomputes
 * client-side when a plane is corrected there; this is the same rule applied
 * where the CLI reads the file, so a plane corrected by hand in the JSON (or
 * by any other tool) takes effect instead of silently changing nothing. The
 * boundary suffix on `source` is re-derived too — a claim flipped testable
 * must not keep a sentence saying it is held as an assumption.
 *
 * The warnings are the honesty half: a lane whose name reads as a database
 * or an external system, marked `user`/`page`, makes the browser the claimed
 * caller of traffic a server almost certainly makes — every claim that lane
 * turns testable would then fail against a perfectly working app ("not
 * observed"), which is precisely the false claim this pipeline must not
 * manufacture. The correction is not refused — the gate's judgement wins —
 * but it is never silent.
 */
export function recomputeLaneTestability(file: ClaimsFile): { changed: number; warnings: string[] } {
  const gate = file.sequence;
  if (!gate?.messages || gate.messages.length === 0) return { changed: 0, warnings: [] };

  const planeOf = new Map<string, string>();
  for (const participant of gate.participants) planeOf.set(participant.name, participant.plane);
  const browserSide = (id: string): boolean => {
    const plane = planeOf.get(id);
    return plane === 'user' || plane === 'page';
  };

  let changed = 0;
  for (const message of gate.messages) {
    const claim = file.claims[message.claim];
    if (!claim) continue;
    const observable = browserSide(message.from) || (message.reply && browserSide(message.to));
    if (claim.testable !== observable) {
      claim.testable = observable;
      changed += 1;
    }
    const base = claim.source.replace(BOUNDARY_SUFFIX_RE, '');
    claim.source = observable
      ? base
      : `${base} (beyond the browser boundary: ${planeOf.get(message.from) ?? 'backend'} → ${planeOf.get(message.to) ?? 'backend'} — held as an assumption)`;
  }

  const warnings: string[] = [];
  for (const participant of gate.participants) {
    if (participant.plane !== 'user' && participant.plane !== 'page') continue;
    const name = `${participant.name} ${participant.label}`;
    if (DB_NAME_RE.test(name) || EXTERNAL_NAME_RE.test(name)) {
      warnings.push(
        `lane "${participant.label}" is marked ${participant.plane} but its name reads as a ` +
          `${DB_NAME_RE.test(name) ? 'database' : 'external system'} — the browser can only observe ` +
          `traffic the page itself makes, so claims this lane turns testable will fail against a ` +
          `working app if the call really happens server-side`,
      );
    }
  }
  return { changed, warnings };
}

/**
 * Fill in plane defaults. Notation facts are not guesses (`actor` → user,
 * `database` → external); everything else is a flagged default the person at
 * the gate confirms — see `SequenceParticipant.guessed`.
 */
export function classifyPlanes(doc: SequenceDoc): void {
  const byId = new Map(doc.participants.map((p) => [p.id, p]));

  for (const participant of doc.participants) {
    if (participant.kind === 'actor') {
      participant.plane = 'user';
      participant.guessed = false;
    } else if (
      participant.kind === 'database' ||
      participant.kind === 'queue' ||
      participant.kind === 'collections'
    ) {
      participant.plane = 'external';
      participant.guessed = false;
    } else if (DB_NAME_RE.test(participant.label) || DB_NAME_RE.test(participant.id)) {
      participant.plane = 'external';
    } else if (EXTERNAL_NAME_RE.test(participant.label) || EXTERNAL_NAME_RE.test(participant.id)) {
      participant.plane = 'external';
    } else if (PAGE_NAME_RE.test(participant.label) || PAGE_NAME_RE.test(participant.id)) {
      participant.plane = 'page';
    }
  }

  // The first thing a user talks to is the page, if nothing said otherwise.
  const pageAssigned = doc.participants.some((p) => p.plane === 'page');
  if (!pageAssigned) {
    for (const message of doc.messages) {
      const from = byId.get(message.from);
      const to = byId.get(message.to);
      if (from?.plane === 'user' && to && to.plane === 'backend' && to.guessed) {
        to.plane = 'page';
        break;
      }
    }
  }
}
