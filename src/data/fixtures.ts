/**
 * Fixture files for `upload` steps — deterministic, $0, written under
 * `.wowlidator/fixtures/<runKey>/`.
 *
 * Ninety-five rows of the HR workbook (2026-09-03) attach a file: the BE Bulk
 * Import CSV wizard (PL_10_*, 44 rows, 27 of which need a DEFECTIVE CSV — a
 * blank column, an operator the list refuses, a TIS-620 encoding, a first row
 * that is data instead of the header), a leave request's medical certificate
 * (TM `กดแนบเอกสาร (Attach)`, 9), the bilingual consent PDFs (4), the EC bulk
 * hire import and the PY Excel upload. None of those files exists on the
 * machine the run is on, and a tester's own `benefit-plans (1).csv` is not
 * evidence anyone else can read.
 *
 * So the author names the file it wants in a small vocabulary and this module
 * makes it, the same bytes for the same spec in the same run:
 *
 *     kind:name[@template][!mutation[=arg]]...
 *
 *     csv:benefit-plans@template
 *     csv:benefit-plans@template!blank=Country
 *     csv:benefit-plans@template!bad-enum=[OPERATOR]:Del!encoding=tis-620
 *     pdf:medical-certificate
 *     xlsx:benefit-plans
 *     txt:not-a-csv
 *
 * The CSV header comes from a TEMPLATE: the columns the case, a context
 * document or the page's own "Download Sample CSV" text lists
 * (`headerTemplateFrom`), or the built-in one for a name this module knows.
 * Every data value is derived from its column name and row number, never from
 * randomness, and the id column carries the run's suffix so an import never
 * collides with an earlier run's rows.
 *
 * This is the fixture half of CG-19. The authoring half (an `upload` action in
 * `AUTHOR_ACTIONS`, `value` = the spec) and the runner half (`setInputFiles` on
 * the input behind the Attach/Dropzone control) live in `flow-author.ts` and
 * `engine/runner.ts`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildZip } from '../reporter/excel-export.js';
import { runSuffix } from './mock-data.js';

export const FIXTURE_KINDS = ['csv', 'pdf', 'xlsx', 'txt'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/** Where fixtures go, under the working directory; one folder per run so a rerun never reads a stale file. */
export const DEFAULT_FIXTURE_ROOT = '.wowlidator/fixtures';

/**
 * The controlled defects a CSV (or xlsx) fixture can carry, one per `!`. The
 * argument names the column where one is needed; `Column:value` sets the
 * value where the default would not do.
 */
export const FIXTURE_MUTATIONS = {
  /** `blank=Country` — the column is empty on every data row (PL_10 "เว้นว่างทีละ Field"). */
  blank: 'a required column left empty',
  /** `bad-enum=[OPERATOR]:Del` — a value the app's list does not hold; `X` when no value is given. */
  'bad-enum': 'a value outside the accepted list',
  /** `bad-date=Effective Start Date` — `31/02/2026`, a date that does not exist. */
  'bad-date': 'a date that does not exist',
  /** `extra-column=Remark` — one column the template does not declare, appended. */
  'extra-column': 'a column the template does not declare',
  /** `rows=1001` — that many data rows (the "> N rows" limit case). */
  rows: 'a set number of data rows',
  /** `encoding=tis-620` (also `utf-8-bom`, `utf-16le`) — the file's byte encoding. */
  encoding: 'a byte encoding other than plain UTF-8',
  /** `delimiter=;` (or `tab`, `pipe`) — the field separator. */
  delimiter: 'a field separator other than the comma',
  /** `no-header` — the first row is data, not the header ("แถวแรกเป็นข้อมูล"). */
  'no-header': 'no header row',
  /** `header-only` — the header and nothing else. */
  'header-only': 'a header with no data rows',
  /** `empty` — a zero-byte file. */
  empty: 'an empty file',
  /** `too-long=Benefit Name:256` — a value that many characters long (256 when unsaid). */
  'too-long': 'a value over the length limit',
  /** `value=Status:Active` — one column set to a literal on every row. */
  value: 'a column set to a literal',
  /** `duplicate` — the second row repeats the first row's id. */
  duplicate: 'a duplicated key across rows',
  /** `size=11` — padded past that many megabytes ("up to 10 MB"). */
  size: 'a file over the size limit',
  /** `crlf` — Windows line endings. */
  crlf: 'CRLF line endings',
} as const;
export type FixtureMutationName = keyof typeof FIXTURE_MUTATIONS;

export interface FixtureMutation {
  name: FixtureMutationName;
  arg: string | null;
}

export interface FixtureSpec {
  kind: FixtureKind;
  /** The file's base name and the template it means (`benefit-plans`). */
  name: string;
  /** `@template` — the header comes from a template (the case, a document, the page, or the built-in). Null: bare. */
  template: string | null;
  mutations: FixtureMutation[];
  /** The spec as written, for the report. */
  raw: string;
}

const SPEC_SHAPE = /^(csv|pdf|xlsx|txt):([A-Za-z0-9][A-Za-z0-9._ -]{0,60}?)(@[A-Za-z0-9._-]+)?((?:![^!]+)*)$/;

/** True when a step's value is a fixture spec rather than text to type. */
export function isFixtureSpec(value: string): boolean {
  return SPEC_SHAPE.test(value.trim());
}

/** `csv:benefit-plans@template!blank=Country` → its parts, or null when it is not a spec. */
export function parseFixtureSpec(value: string): FixtureSpec | null {
  const raw = value.trim();
  const m = SPEC_SHAPE.exec(raw);
  if (m === null) return null;
  const mutations: FixtureMutation[] = [];
  for (const piece of (m[4] ?? '').split('!')) {
    const part = piece.trim();
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (!(name in FIXTURE_MUTATIONS)) return null;
    const arg = eq === -1 ? null : part.slice(eq + 1).trim();
    mutations.push({ name: name as FixtureMutationName, arg: arg === '' ? null : arg });
  }
  return {
    kind: m[1] as FixtureKind,
    name: m[2]!.trim(),
    template: m[3] === undefined ? null : m[3].slice(1),
    mutations,
    raw,
  };
}

// --- header templates --------------------------------------------------------------

/**
 * The templates this module knows by name, for when no text names one. The
 * benefit-plans header is the one the BE sheet's own row PL_10_03 lists as
 * what "Download Sample CSV" produces (16 columns, `Company` last).
 */
export const BUILTIN_TEMPLATES: Record<string, readonly string[]> = {
  'benefit-plans': [
    '[OPERATOR]',
    'Country',
    'Benefit Category',
    'Benefit Plan ID',
    'Benefit Name',
    'Status',
    'Effective Start Date',
    'Effective End Date',
    'Benefit Type',
    'Enrollment',
    'Claim Period',
    'Entitlement Amount Calculation Method',
    'Eligible Claim Date',
    'Special Claim Condition Flag',
    'Special Claim Condition',
    'Company',
  ],
  'eligibility-rules': ['[OPERATOR]', 'Country', 'Rule ID', 'Rule Name', 'Benefit Plan ID', 'Status', 'Effective Start Date', 'Effective End Date', 'Condition'],
  employees: ['Employee ID', 'First Name', 'Last Name', 'Hire Date', 'Position', 'Company', 'Status'],
};

/** A line's comma-separated cells, when it reads as a header: 4+ short cells, every one with a letter. */
function headerCellsOf(line: string): string[] | null {
  const cells = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
  if (cells.length < 4) return null;
  if (!cells.every((c) => c !== '' && c.length <= 60 && /\p{L}/u.test(c) && !/^\d+(?:\.\d+)?$/.test(c))) return null;
  // A prose sentence with commas has words per cell; a header has labels.
  if (cells.some((c) => c.split(/\s+/).length > 6)) return null;
  return cells;
}

/**
 * The header a text states — a case's "Template แสดง Column A, B, C…", a
 * context document, or the page's own sample CSV — as the column list. When
 * `name` is given, the line nearest a mention of the name's words wins;
 * otherwise the first header-looking line. Null when the text lists none.
 */
export function headerTemplateFrom(text: string, name?: string): string[] | null {
  const lines = text.split(/\r?\n/);
  const candidates: { index: number; cells: string[] }[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    // "… Column [OPERATOR], Country, …" — the list starts after the word.
    const after = /(?:columns?|คอลัมน์|header|fields?)\s*[:：]?\s*(.+)$/i.exec(line)?.[1];
    const cells = (after !== undefined ? headerCellsOf(after) : null) ?? headerCellsOf(line);
    if (cells !== null) candidates.push({ index, cells });
  }
  if (candidates.length === 0) return null;
  if (name === undefined) return candidates[0]!.cells;
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const mentions = (i: number): boolean => {
    const window = lines.slice(Math.max(0, i - 3), i + 1).join(' ').toLowerCase();
    return words.some((w) => window.includes(w) || window.includes(w.replace(/s$/, '')));
  };
  return (candidates.find((c) => mentions(c.index)) ?? candidates[0]!).cells;
}

// --- values ----------------------------------------------------------------------

export interface FixtureBuildOptions {
  runKey: string;
  /** The case the file is for; its id seeds the key column. */
  caseId?: string | undefined;
  /** The header to use, when the caller found one (`headerTemplateFrom`); the built-in or a generic one otherwise. */
  headers?: readonly string[] | undefined;
  /** Text to look for a header template in, when `headers` is not given. */
  templateText?: string | undefined;
  /** Data rows unless a `rows=` mutation says otherwise. Two by default: enough to show a table, few enough to read. */
  rows?: number | undefined;
}

export interface FixtureFile {
  fileName: string;
  bytes: Buffer;
  mediaType: string;
  /** One line for the report: what the file is and which defect it carries. */
  description: string;
  /** For tabular kinds: the header used and how many data rows were written. */
  headers?: readonly string[] | undefined;
  rows?: number | undefined;
}

/** A Thai plan name: the one place a TIS-620 mutation has something to encode. */
const THAI_SAMPLE = 'ค่ารักษาพยาบาล';

/**
 * A cell from its column name and row number. Every rule is a guess at what
 * an HR import expects, and a guess a reader can see in the file — the point
 * is a file the wizard accepts as VALID, so the defect a mutation adds is the
 * only thing wrong with it.
 */
function cellFor(column: string, row: number, options: FixtureBuildOptions): string {
  const c = column.toLowerCase();
  const suffix = runSuffix(options.runKey) || 'run';
  const key = `${(options.caseId ?? 'QA').replace(/[^A-Za-z0-9_-]+/g, '_')}_${suffix}_R${row}`;
  if (/^\[?operator\]?$/.test(c)) return 'Create';
  if (/\bcountry\b/.test(c)) return 'TH';
  if (/\bcompany\b/.test(c)) return 'CRG';
  if (/\bstatus\b/.test(c)) return 'Active';
  if (/\bflag\b|\(y\/n\)/.test(c)) return 'N';
  if (/effective end|end date|expiry|expire/.test(c)) return '9999-12-31';
  if (/effective start|start date|hire date|eligible claim date/.test(c)) return '2026-01-01';
  if (/\bdate\b|วันที่/.test(c)) return '2026-01-01';
  if (/\bbenefit type\b/.test(c)) return 'Reimbursement';
  if (/\benrollment\b/.test(c)) return 'Auto';
  if (/\bclaim period\b/.test(c)) return 'Yearly';
  if (/calculation method/.test(c)) return 'Fixed';
  if (/\bcategory\b/.test(c)) return 'Medical';
  if (/\bcondition\b/.test(c)) return '';
  if (/\bamount\b|\bqty\b|\bquantity\b|\bnumber of\b/.test(c)) return '1000';
  if (/\(th\)|\bth\b|ภาษาไทย|ชื่อ/.test(c)) return `${THAI_SAMPLE} ${key}`;
  if (/\bid\b|\bcode\b|รหัส/.test(c)) return key;
  if (/\bname\b/.test(c)) return `QA ${column} ${key}`;
  if (/\bemail\b/.test(c)) return `qa.${suffix.toLowerCase()}.r${row}@example.com`;
  return `${column} ${row}`;
}

interface Table {
  headers: string[];
  rows: string[][];
}

function findColumn(headers: readonly string[], wanted: string): number {
  const want = wanted.trim().toLowerCase();
  const exact = headers.findIndex((h) => h.trim().toLowerCase() === want);
  if (exact !== -1) return exact;
  return headers.findIndex((h) => h.trim().toLowerCase().includes(want));
}

/** `Column:value` → both; `Column` → the column and null. */
function columnArg(arg: string | null): { column: string; value: string | null } {
  if (arg === null) return { column: '', value: null };
  const colon = arg.indexOf(':');
  return colon === -1 ? { column: arg, value: null } : { column: arg.slice(0, colon), value: arg.slice(colon + 1) };
}

/** The table a tabular spec describes, mutations applied. Throws when a mutation names a column the header lacks. */
function tableFor(spec: FixtureSpec, options: FixtureBuildOptions): Table {
  const headers = [...(options.headers ?? (options.templateText === undefined ? null : headerTemplateFrom(options.templateText, spec.name)) ?? BUILTIN_TEMPLATES[spec.name.toLowerCase()] ?? BUILTIN_TEMPLATES[spec.template?.toLowerCase() ?? ''] ?? ['ID', 'Name', 'Status', 'Effective Start Date', 'Effective End Date'])];
  const rowsWanted = spec.mutations.find((m) => m.name === 'rows');
  const headerOnly = spec.mutations.some((m) => m.name === 'header-only');
  const count = headerOnly ? 0 : Math.max(0, Number(rowsWanted?.arg ?? options.rows ?? 2) || 0);
  const rows: string[][] = [];
  for (let r = 1; r <= count; r += 1) rows.push(headers.map((h) => cellFor(h, r, options)));
  const table: Table = { headers, rows };
  for (const mutation of spec.mutations) {
    const { column, value } = columnArg(mutation.arg);
    const at = column === '' ? -1 : findColumn(table.headers, column);
    const need = (): number => {
      if (at === -1) throw new Error(`fixture ${spec.raw}: "${mutation.name}" names column "${column}", which the header does not have (${table.headers.join(', ')})`);
      return at;
    };
    switch (mutation.name) {
      case 'blank':
        for (const row of table.rows) row[need()] = '';
        break;
      case 'bad-enum':
        for (const row of table.rows) row[need()] = value ?? 'X';
        break;
      case 'bad-date':
        for (const row of table.rows) row[need()] = value ?? '31/02/2026';
        break;
      case 'too-long': {
        const length = Math.max(1, Number(value ?? 256) || 256);
        for (const row of table.rows) row[need()] = 'X'.repeat(length);
        break;
      }
      case 'value':
        for (const row of table.rows) row[need()] = value ?? '';
        break;
      case 'extra-column': {
        const name = column === '' ? 'Extra Column' : column;
        table.headers.push(name);
        for (const row of table.rows) row.push(value ?? `${name} value`);
        break;
      }
      case 'duplicate': {
        const idAt = column === '' ? table.headers.findIndex((h) => /\bid\b|\bcode\b|รหัส/i.test(h)) : need();
        if (idAt !== -1 && table.rows.length >= 2) table.rows[1]![idAt] = table.rows[0]![idAt]!;
        break;
      }
      case 'no-header':
        table.headers = [];
        break;
      default:
        break;
    }
  }
  return table;
}

// --- writers --------------------------------------------------------------------------

function csvCell(value: string, delimiter: string): string {
  return new RegExp(`[${delimiter === '|' ? '\\|' : delimiter}"\\r\\n]`).test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** TIS-620: the Thai block U+0E01–U+0E5B maps one-to-one onto 0xA1–0xFB; everything else must be ASCII. */
function encodeTis620(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp >= 0x0e01 && cp <= 0x0e5b) out.push(cp - 0x0e00 + 0xa0);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

function encodeText(text: string, encoding: string | null): Buffer {
  const e = (encoding ?? 'utf-8').toLowerCase();
  if (e === 'tis-620' || e === 'tis620' || e === 'ansi' || e === 'windows-874' || e === 'cp874') return encodeTis620(text);
  if (e === 'utf-8-bom' || e === 'utf8-bom' || e === 'bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (e === 'utf-16le' || e === 'utf-16' || e === 'utf16') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return Buffer.from(text, 'utf8');
}

function csvBytes(table: Table, spec: FixtureSpec): Buffer {
  const delimiterArg = spec.mutations.find((m) => m.name === 'delimiter')?.arg ?? ',';
  const delimiter = delimiterArg === 'tab' ? '\t' : delimiterArg === 'pipe' ? '|' : delimiterArg === 'semicolon' ? ';' : delimiterArg;
  const eol = spec.mutations.some((m) => m.name === 'crlf') ? '\r\n' : '\n';
  const lines = [...(table.headers.length ? [table.headers] : []), ...table.rows].map((cells) => cells.map((c) => csvCell(c, delimiter)).join(delimiter));
  let text = lines.join(eol) + eol;
  const size = spec.mutations.find((m) => m.name === 'size');
  if (size !== undefined && table.rows.length > 0) {
    // Repeat the data rows until the file is past the limit — the same rows, so it is still a well-formed CSV.
    const limit = Math.max(1, Number(size.arg ?? 11) || 11) * 1024 * 1024;
    const body = table.rows.map((cells) => cells.map((c) => csvCell(c, delimiter)).join(delimiter)).join(eol) + eol;
    while (Buffer.byteLength(text, 'utf8') <= limit) text += body;
  }
  return encodeText(text, spec.mutations.find((m) => m.name === 'encoding')?.arg ?? null);
}

function xmlEsc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML 1.0 and Excel refuses the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

function columnRef(index: number): string {
  let n = index + 1;
  let ref = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    ref = String.fromCharCode(65 + r) + ref;
    n = Math.floor((n - 1) / 26);
  }
  return ref;
}

/** A one-sheet workbook of inline strings, through the reporter's own zip writer. */
function xlsxBytes(table: Table, sheetName: string): Buffer {
  const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, 'utf8');
  const all = [...(table.headers.length ? [table.headers] : []), ...table.rows];
  const rowsXml = all
    .map((cells, r) => {
      const cellsXml = cells
        .map((c, i) => (c === '' ? '' : `<c r="${columnRef(i)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`))
        .join('');
      return `<row r="${r + 1}">${cellsXml}</row>`;
    })
    .join('');
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: xml(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${xmlEsc(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`),
    },
  ]);
}

/** A PDF string literal: parentheses and backslashes escaped, anything outside Latin-1 shown as `?`. */
function pdfLiteral(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (cp < 0x20 || cp > 0xff) out += '?';
    else out += ch;
  }
  return out;
}

/**
 * One A4 page, Helvetica, the given lines — a minimal but complete PDF 1.4:
 * catalog, pages, page, content, font, a correct xref table. The `extract.ts`
 * reader (an independent implementation, written against real PDFs) reads
 * the lines back, which is how the test knows the file is a PDF and not a
 * file that starts with `%PDF`.
 */
export function pdfBytes(lines: readonly string[], title: string): Buffer {
  const content = ['BT', '/F1 12 Tf', '72 770 Td', '16 TL', ...lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${pdfLiteral(l)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title (${pdfLiteral(title)}) /Producer (wowlidator) >>`,
  ];
  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** `blank=Country!encoding=tis-620` → `blank-country.encoding-tis-620`, for the file name; a symbol argument is named. */
function mutationTag(mutations: readonly FixtureMutation[]): string {
  const named: Record<string, string> = { ';': 'semicolon', '|': 'pipe', '\t': 'tab', ',': 'comma' };
  return mutations
    .map((m) => `${m.name}${m.arg === null ? '' : `-${named[m.arg] ?? m.arg}`}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('.');
}

const MEDIA_TYPES: Record<FixtureKind, string> = {
  csv: 'text/csv',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};

/**
 * The file a spec describes, in memory. Pure: the same spec, run key, case id
 * and header give the same bytes. Throws only for a spec that cannot be
 * built (a mutation naming a column the header lacks) — the author's mistake,
 * to be reported at authoring, never at run time.
 */
export function buildFixture(spec: FixtureSpec | string, options: FixtureBuildOptions): FixtureFile {
  const parsed = typeof spec === 'string' ? parseFixtureSpec(spec) : spec;
  if (parsed === null) throw new Error(`"${String(spec)}" is not a fixture spec (kind:name[@template][!mutation]…)`);
  const suffix = runSuffix(options.runKey) || 'run';
  const tag = mutationTag(parsed.mutations);
  const stem = `${parsed.name.replace(/[^A-Za-z0-9._-]+/g, '-')}-${suffix}${tag === '' ? '' : `.${tag}`}`;
  const fileName = `${stem}.${parsed.kind}`;
  const defects = parsed.mutations.map((m) => `${FIXTURE_MUTATIONS[m.name]}${m.arg === null ? '' : ` (${m.arg})`}`);
  const empty = parsed.mutations.some((m) => m.name === 'empty');
  const marker = `wowlidator fixture ${parsed.name} for run ${suffix}${options.caseId === undefined ? '' : ` case ${options.caseId}`}`;

  if (parsed.kind === 'pdf') {
    const lines = [parsed.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), marker, 'This page is a test fixture; it stands in for the document the case names.'];
    return {
      fileName,
      bytes: empty ? Buffer.alloc(0) : pdfBytes(lines, parsed.name),
      mediaType: MEDIA_TYPES.pdf,
      description: `${fileName}: one-page PDF${defects.length ? `, ${defects.join(', ')}` : ''}`,
    };
  }
  if (parsed.kind === 'txt') {
    return {
      fileName,
      bytes: empty ? Buffer.alloc(0) : Buffer.from(`${marker}\n`, 'utf8'),
      mediaType: MEDIA_TYPES.txt,
      description: `${fileName}: plain text${defects.length ? `, ${defects.join(', ')}` : ''}`,
    };
  }
  const table = tableFor(parsed, options);
  const bytes = empty ? Buffer.alloc(0) : parsed.kind === 'xlsx' ? xlsxBytes(table, parsed.name) : csvBytes(table, parsed);
  return {
    fileName,
    bytes,
    mediaType: MEDIA_TYPES[parsed.kind],
    description: `${fileName}: ${table.rows.length} data row(s) under ${table.headers.length === 0 ? 'no header' : `${table.headers.length} columns`}${defects.length ? `, ${defects.join(', ')}` : ''}`,
    headers: table.headers,
    rows: table.rows.length,
  };
}

/** The folder a run's fixtures live in; the run key is made path-safe and can never climb out. */
export function fixtureDir(runKey: string, root = DEFAULT_FIXTURE_ROOT): string {
  const safe = runKey.replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '') || 'run';
  return join(root, safe);
}

/**
 * Build the file and write it under `<root>/<runKey>/`. Rewriting the same
 * spec in the same run writes the same bytes to the same path, so a case
 * that uploads twice, or a rerun under the run key, sees one file.
 */
export async function writeFixture(
  spec: FixtureSpec | string,
  options: FixtureBuildOptions & { root?: string | undefined },
): Promise<FixtureFile & { path: string }> {
  const file = buildFixture(spec, options);
  const dir = fixtureDir(options.runKey, options.root ?? DEFAULT_FIXTURE_ROOT);
  await mkdir(dir, { recursive: true });
  const path = join(dir, file.fileName);
  await writeFile(path, file.bytes);
  return { ...file, path };
}
