/**
 * Turning a document into the text a model can read.
 *
 * A catalog is whatever a team already writes down: a requirements page saved
 * as HTML, a QA checklist in markdown, a spreadsheet of cases, a PDF spec. None
 * of that is a test, and none of it should have to be retyped to become one.
 * This module is the one place a file becomes characters; everything after it
 * deals in text only.
 *
 * ## Why this is hand-rolled
 *
 * `.xlsx` and `.pdf` both have mature parsers on npm, and neither is pulled in
 * here. Both are containers this module needs one narrow thing from — cell
 * strings, and text-showing operators — and a dependency that can render a
 * spreadsheet or rasterise a page is a great deal of surface to carry into a
 * test framework for that. `node:zlib` supplies the only hard part (inflate),
 * and what remains is a few hundred lines that can be read in one sitting.
 *
 * ## The rule that matters more than the formats
 *
 * **Never hand back text that is not in the document.** Extraction is the one
 * step in this whole feature where a silent mistake is invisible downstream: a
 * model asked to write tests from mangled text writes plausible tests about
 * nothing, and every layer after this one — the claims, the steps, the run, the
 * green report — inherits the error while looking exactly like success. So:
 *
 * - A format that cannot be read is **refused by extension**, not guessed at.
 * - A PDF with no text layer (a scan) **throws**, naming the likely cause,
 *   rather than returning the handful of stray characters a scan usually has.
 * - Anything approximated — a dropped sheet, a truncation — comes back on
 *   `note`, and the callers put it in front of the person, not in a log.
 */

import { readFile } from 'node:fs/promises';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { basename, extname } from 'node:path';

import { parseSequenceDiagram } from './sequence.js';

export type DocumentFormat =
  | 'text'
  | 'markdown'
  | 'csv'
  | 'html'
  | 'json'
  | 'yaml'
  | 'xlsx'
  | 'pdf'
  | 'sequence'
  /**
   * An IMAGE of a sequence diagram. Deliberately absent from `FORMATS`: this
   * extractor is deterministic and never calls a model, so it cannot read
   * pixels — `catalog` routes images through the vision transcriber in
   * `diagram-image.ts` first, and what reaches extraction is the transcribed
   * `.mmd`. The member exists so uploads can carry the format label.
   */
  | 'pptx'
  | 'sequence-image';

/** Extensions this module will attempt, and what it treats each as. */
const FORMATS: Record<string, DocumentFormat> = {
  '.txt': 'text',
  '.text': 'text',
  '.log': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.html': 'html',
  '.htm': 'html',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.pptx': 'pptx',
  '.ppsx': 'pptx',
  '.pdf': 'pdf',
  // Sequence diagrams — Mermaid and PlantUML source. Decided by extension
  // like everything else here; a fenced ```mermaid block inside a `.md` keeps
  // the markdown path it always had.
  '.mmd': 'sequence',
  '.mermaid': 'sequence',
  '.puml': 'sequence',
  '.plantuml': 'sequence',
};

/** Formats worth naming in an error, and in the UI's file picker. */
export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS);

/**
 * How much extracted text is handed on.
 *
 * The whole point of a catalog is that it is *long* — but the model's context
 * is not, and a prompt that overruns it fails in a way that reads like a model
 * problem. Truncation is reported, never silent.
 */
export const DEFAULT_MAX_CHARS = 120_000;

/** Bigger than this and something is wrong with the input, not with the cap. */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;

export interface ExtractedDocument {
  /** File name, for the prompt and for anything the UI shows. */
  name: string;
  format: DocumentFormat;
  text: string;
  /** What was approximated, dropped or truncated. Empty when nothing was. */
  note: string;
  /** Characters before any truncation. */
  originalChars: number;
}

export class UnsupportedDocumentError extends Error {
  constructor(name: string) {
    super(
      `cannot read "${name}" — wowlidator extracts text from ` +
        `${SUPPORTED_EXTENSIONS.join(' ')}. ` +
        'Export it as one of those, or paste the text instead.',
    );
    this.name = 'UnsupportedDocumentError';
  }
}

export class EmptyDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyDocumentError';
  }
}

export function formatFor(name: string): DocumentFormat | undefined {
  return FORMATS[extname(name).toLowerCase()];
}

export async function extractDocumentFile(
  path: string,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ExtractedDocument> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new UnsupportedDocumentError(
      `${basename(path)} (${Math.round(bytes.byteLength / 1024 / 1024)}MB — the limit is ${MAX_FILE_BYTES / 1024 / 1024}MB)`,
    );
  }
  return extractDocument(basename(path), bytes, maxChars);
}

/** The one entry point. `bytes` is the file exactly as it sits on disk. */
export function extractDocument(
  name: string,
  bytes: Buffer,
  maxChars = DEFAULT_MAX_CHARS,
): ExtractedDocument {
  const format = formatFor(name);
  if (format === undefined) throw new UnsupportedDocumentError(name);

  let text: string;
  let note = '';

  switch (format) {
    case 'xlsx': {
      const sheets = readXlsx(bytes);
      text = sheets.text;
      note = sheets.note;
      break;
    }
    case 'pptx': {
      const deck = readPptx(bytes);
      text = deck.text;
      note = deck.note;
      break;
    }
    case 'pdf': {
      const pdf = readPdf(bytes);
      text = pdf.text;
      note = pdf.note;
      break;
    }
    case 'csv': {
      const table = csvToText(decodeText(bytes), extname(name).toLowerCase() === '.tsv');
      text = table.text;
      note = table.note;
      break;
    }
    case 'html':
      text = htmlToText(decodeText(bytes));
      break;
    case 'sequence': {
      // The text goes through verbatim — the deterministic claims path
      // re-parses it — but it is validated *here*, where a refusal can name
      // the file, and anything the parser will skip (unsupported blocks,
      // ignored lines) comes back on `note` so the person sees it before the
      // claims do. Parsing twice is cheap; a silent skip is not.
      text = decodeText(bytes);
      const doc = parseSequenceDiagram(text); // throws SequenceParseError when unreadable
      note = joinNotes(...doc.notes);
      break;
    }
    default:
      text = decodeText(bytes);
      break;
  }

  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const originalChars = text.length;

  if (text === '') {
    throw new EmptyDocumentError(
      `"${name}" produced no text. ` +
        (format === 'pdf'
          ? 'A PDF with no text layer is usually a scan — export the original, or paste the text.'
          : 'The file appears to be empty.'),
    );
  }

  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    note = joinNotes(
      note,
      `truncated to the first ${maxChars.toLocaleString('en-US')} of ${originalChars.toLocaleString('en-US')} characters`,
    );
  }

  return { name, format, text, note, originalChars };
}

function joinNotes(...notes: string[]): string {
  return notes.filter((note) => note !== '').join('; ');
}

// --- HTML -------------------------------------------------------------------

/**
 * HTML to something a model reads as a document, not as markup.
 *
 * Structure is kept where it carries meaning — a heading is a heading, a table
 * row is a row — because a requirements page flattened into one paragraph
 * loses exactly the grouping that says which claims belong together. Script and
 * style content is dropped outright: it is not prose, and it is the bulk of a
 * saved page.
 */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '');

  out = out
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|thead|tbody)>/gi, '\n')
    // A cell boundary is information: two columns are not one sentence.
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(out)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/, ''))
    .join('\n');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// --- ZIP (the container .xlsx is) -------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Just enough ZIP to read an `.xlsx`.
 *
 * Entries are found through the **central directory**, not by scanning for
 * local headers: a local header's sizes may be zero with the real values in a
 * trailing data descriptor, and a scanner that trusts them walks off into the
 * middle of a compressed stream. The central directory always has the true
 * sizes.
 */
function readZip(bytes: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === -1) throw new UnsupportedDocumentError('this file is not a readable .xlsx (no ZIP directory)');

  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);

    try {
      entries.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    } catch {
      // One unreadable member is not a reason to lose the rest of the workbook.
      continue;
    }
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // The record is at the end, after a comment of up to 64KB.
  const floor = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// --- XLSX -------------------------------------------------------------------

/**
 * A workbook as tab-separated rows, one block per sheet.
 *
 * Cells carry their column letter only when a row is sparse, because a
 * spreadsheet of test cases reads as a table and a table wants alignment; but a
 * row with three values in columns A, D and Q is not a three-column row, and
 * flattening it would silently move data under the wrong heading.
 */
function readXlsx(bytes: Buffer): { text: string; note: string } {
  const entries = readZip(bytes);
  const shared = readSharedStrings(entries.find((entry) => entry.name === 'xl/sharedStrings.xml')?.data);
  const names = readSheetNames(entries.find((entry) => entry.name === 'xl/workbook.xml')?.data);

  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  if (sheets.length === 0) {
    throw new EmptyDocumentError('this workbook has no worksheets wowlidator can read');
  }

  const blocks: string[] = [];
  let skipped = 0;
  for (const [index, sheet] of sheets.entries()) {
    const rows = readSheet(sheet.data.toString('utf8'), shared);
    if (rows.length === 0) {
      skipped += 1;
      continue;
    }
    blocks.push(`## ${names[index] ?? `Sheet ${index + 1}`}\n${rows.join('\n')}`);
  }

  return {
    text: blocks.join('\n\n'),
    note: skipped > 0 ? `${skipped} empty sheet(s) skipped` : '',
  };
}

/**
 * A PowerPoint deck, read the same way the workbook is: through the ZIP's
 * central directory, taking the one narrow thing needed — the text runs.
 *
 * One slide is one `ppt/slides/slideN.xml`; visible text lives in `<a:t>`
 * runs, one paragraph per `<a:p>` (joining runs within a paragraph is what
 * keeps a title split by formatting from reading as two lines). Slide notes
 * (`ppt/notesSlides/`) are read too, labelled apart — a speaker note is the
 * author talking, not the slide asserting — and everything else in the
 * package (themes, layouts, media) is never touched. A deck whose slides are
 * pictures of text yields nothing readable and is refused with the cause
 * named, the same rule as a PDF with no text layer.
 */
function readPptx(bytes: Buffer): { text: string; note: string } {
  const entries = readZip(bytes);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  if (slides.length === 0) {
    throw new EmptyDocumentError('this presentation has no slides wowlidator can read');
  }

  const notesByslide = new Map<string, string[]>();
  for (const entry of entries) {
    const m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(entry.name);
    if (m) notesByslide.set(m[1] as string, slideParagraphs(entry.data.toString('utf8')));
  }

  const blocks: string[] = [];
  let empty = 0;
  for (const slide of slides) {
    const n = (/slide(\d+)\.xml$/.exec(slide.name)?.[1] ?? '') as string;
    const paragraphs = slideParagraphs(slide.data.toString('utf8'));
    const notes = (notesByslide.get(n) ?? []).filter((line) => !/^\d+$/.test(line));
    if (paragraphs.length === 0 && notes.length === 0) {
      empty += 1;
      continue;
    }
    blocks.push(
      `## Slide ${n}\n${paragraphs.join('\n')}` +
        (notes.length > 0 ? `\n\n(speaker notes)\n${notes.join('\n')}` : ''),
    );
  }

  if (blocks.length === 0) {
    throw new EmptyDocumentError(
      'no readable text on any slide — a deck of images (screenshots, exported pictures) has no text layer to read',
    );
  }

  return {
    text: blocks.join('\n\n'),
    note: empty > 0 ? `${empty} slide(s) with no readable text skipped` : '',
  };
}

/** The visible paragraphs of one slide (or notes) XML part, in document order. */
function slideParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const para of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...(para[1] ?? '').matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((run) =>
      decodeEntities(run[1] ?? ''),
    );
    const line = runs.join('').trim();
    if (line !== '') paragraphs.push(line);
  }
  return paragraphs;
}

function readSharedStrings(data: Buffer | undefined): string[] {
  if (data === undefined) return [];
  const xml = data.toString('utf8');
  const strings: string[] = [];
  // One <si> is one string, but it may be split across several <t> runs by
  // formatting — joining them is what keeps "Log in" from becoming "Log"/"in".
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...(match[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) =>
      decodeEntities(run[1] ?? ''),
    );
    strings.push(parts.join(''));
  }
  return strings;
}

function readSheetNames(data: Buffer | undefined): string[] {
  if (data === undefined) return [];
  return [...data.toString('utf8').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) =>
    decodeEntities(match[1] ?? ''),
  );
}

function readSheet(xml: string, shared: string[]): string[] {
  const rows: string[] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: { column: string; value: string }[] = [];

    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const type = /\bt="([^"]*)"/.exec(attributes)?.[1] ?? 'n';
      const column = /\br="([A-Z]+)/.exec(attributes)?.[1] ?? '';

      let value: string;
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = shared[index] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((run) => decodeEntities(run[1] ?? ''))
          .join('');
      } else {
        // A formula cell carries both <f> and the cached <v>; the value is the
        // thing a reader sees, so the formula is dropped rather than shown.
        value = decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      value = value.replace(/[\t\n]+/g, ' ').trim();
      if (value !== '') cells.push({ column, value });
    }

    if (cells.length === 0) continue;
    // A dense row is a table row; a sparse one keeps its column letters so a
    // value cannot end up read under a heading it never sat beneath.
    const dense = isDense(cells.map((cell) => cell.column));
    rows.push(
      dense
        ? cells.map((cell) => cell.value).join('\t')
        : cells.map((cell) => `${cell.column}: ${cell.value}`).join('\t'),
    );
  }

  return rows;
}

/** Columns with no gaps, starting at A or B — i.e. an ordinary table row. */
function isDense(columns: string[]): boolean {
  if (columns.some((column) => column === '')) return false;
  const indices = columns.map(columnIndex);
  if ((indices[0] ?? 0) > 1) return false;
  return indices.every((value, i) => i === 0 || value === (indices[i - 1] ?? 0) + 1);
}

function columnIndex(column: string): number {
  let index = 0;
  for (const character of column) index = index * 26 + (character.charCodeAt(0) - 64);
  return index;
}

// --- CSV / TSV --------------------------------------------------------------

/**
 * Text out of bytes, honouring whatever byte-order mark the exporter left.
 *
 * "Save as CSV" writes UTF-16 on more than one platform, and a UTF-16 file read
 * as UTF-8 is not slightly wrong — it is a wall of NUL bytes between every
 * character, which parses as one enormous unreadable field. A BOM is three or
 * two bytes of certainty about something otherwise unknowable, so it is used.
 * With no BOM this is UTF-8, which is what the rest of the module assumed
 * before and what every modern exporter writes.
 */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Node has no utf16be decoder; swapping in place is the whole difference.
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // A UTF-8 BOM survives `toString('utf8')` as U+FEFF and would otherwise end
  // up glued to the first header name — `step_no` read as `﻿step_no`.
  return bytes.toString('utf8').replace(/^﻿/, '');
}

/** Sniffed in this order; the first that produces a consistent table wins. */
const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * How wide a table has to get before rows are written out as labelled records
 * rather than as lines. Past this, a line of tab-separated cells is something
 * only a spreadsheet can read back.
 */
const WIDE_TABLE_COLUMNS = 3;
/** …and how long one cell may be before the same is true of a single row. */
const LONG_CELL_CHARS = 120;

/**
 * A delimited table as text a model can read.
 *
 * The previous behaviour was `bytes.toString('utf8')` — the CSV handed on
 * verbatim. That is adequate for a narrow checklist and wrong for the thing
 * teams actually keep their cases in: a test-script export is fifteen columns
 * wide, quotes half of them, and puts numbered steps *inside* a cell as real
 * newlines. Handed over raw, the quoting is noise the model has to decode
 * before it can read anything, and a multi-line cell makes every row after it
 * look like a new row.
 *
 * So the table is parsed and rewritten, and the shape is chosen from the table
 * rather than fixed:
 *
 * - **narrow and short** — one line per row, cells separated. A three-column
 *   checklist reads perfectly well as lines and costs a third of the tokens.
 * - **wide, or with multi-line or long cells** — one labelled block per row,
 *   `Column: value`, empty cells omitted. This is the shape a test-script
 *   export needs: it is the only one where "Expected Output" stays attached to
 *   the case it belongs to.
 *
 * Row order is preserved exactly, which is the whole of how grouping survives.
 * A sheet that states a scenario once and leaves the cell blank for the three
 * cases beneath it is *not* filled in here — carrying that value down would be
 * this module inventing text that is not in the document, which is the one
 * thing it must never do. The rows stay adjacent and in order, and the model
 * reads the grouping the same way a person does.
 */
function csvToText(raw: string, forceTab = false): { text: string; note: string } {
  const delimiter = forceTab ? '\t' : sniffDelimiter(raw);
  const rows = parseDelimited(raw, delimiter).filter((row) =>
    row.some((cell) => cell.trim() !== ''),
  );
  if (rows.length === 0) return { text: '', note: '' };

  const notes: string[] = [];
  const width = Math.max(...rows.map((row) => row.length));

  // Columns that are empty in every row, including the header. An exporter
  // that ends each line with a trailing delimiter produces one of these, and it
  // would otherwise become a nameless field on every record.
  const keep: number[] = [];
  for (let column = 0; column < width; column += 1) {
    if (rows.some((row) => (row[column] ?? '').trim() !== '')) keep.push(column);
  }
  if (keep.length < width) notes.push(`${width - keep.length} empty column(s) dropped`);

  const headerIndex = findHeaderRow(rows, keep);
  if (headerIndex > 0) {
    notes.push(
      `${headerIndex} row(s) above the header kept as a preamble`,
    );
  }

  const cell = (row: string[], column: number): string => (row[column] ?? '').trim();
  const headers = keep.map((column, i) => {
    const label = cell(rows[headerIndex] ?? [], column);
    return label === '' ? `Column ${i + 1}` : label;
  });

  const preamble = rows.slice(0, headerIndex).map((row) =>
    keep
      .map((column) => cell(row, column))
      .filter((value) => value !== '')
      .join(' — '),
  );

  const body = rows.slice(headerIndex + 1);
  const wide =
    headers.length > WIDE_TABLE_COLUMNS ||
    body.some((row) =>
      keep.some((column) => {
        const value = cell(row, column);
        return value.includes('\n') || value.length > LONG_CELL_CHARS;
      }),
    );

  const blocks: string[] = [];
  if (preamble.length > 0) blocks.push(preamble.join('\n'));

  if (!wide) {
    blocks.push([headers.join(' | '), ...body.map((row) =>
      keep.map((column) => cell(row, column)).join(' | '),
    )].join('\n'));
  } else {
    for (const [index, row] of body.entries()) {
      const fields: string[] = [];
      for (const [i, column] of keep.entries()) {
        const value = cell(row, column);
        if (value === '') continue;
        const label = headers[i] ?? `Column ${i + 1}`;
        fields.push(
          value.includes('\n')
            // Indented, so a numbered list inside one cell cannot be read as
            // the start of the next field.
            ? `${label}:\n${value.split('\n').map((line) => `  ${line.trim()}`).join('\n')}`
            : `${label}: ${value}`,
        );
      }
      if (fields.length === 0) continue;
      // Numbered by their line in the file, so anything questionable here can
      // be looked up in the spreadsheet it came from.
      blocks.push(`## row ${headerIndex + index + 2}\n${fields.join('\n')}`);
    }
  }

  const text = blocks.join('\n\n');
  return { text, note: joinNotes(notes.join('; '), replacementNote(text)) };
}

/**
 * Which delimiter this file uses.
 *
 * Decided by which one yields the most columns *consistently*, not by which is
 * commonest: prose full of commas inside two semicolon-separated fields has
 * plenty of commas and no structure, and consistency is exactly what tells
 * those apart. A file whose fields are quoted is parsed with each candidate for
 * the same reason — counting raw characters would count every delimiter that
 * sits harmlessly inside a quoted cell.
 */
export function sniffDelimiter(raw: string): string {
  const sample = raw.slice(0, 64_000);
  let best: string = DELIMITERS[0];
  let bestScore = -1;

  for (const candidate of DELIMITERS) {
    const rows = parseDelimited(sample, candidate).slice(0, 20);
    if (rows.length === 0) continue;
    const counts = rows.map((row) => row.length);
    const columns = Math.max(...counts);
    if (columns < 2) continue;
    const consistent = counts.filter((count) => count === columns).length / counts.length;
    const score = columns * consistent;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * The row the column names are on.
 *
 * Rarely row 1: an exported sheet usually opens with a title, a date, an author,
 * each of them one filled cell on an otherwise empty row. The header is the
 * first row that fills most of the table's width — which is what distinguishes
 * it from both the title above it and, weakly, from the data below, since data
 * rows in these sheets are routinely sparse. Nothing above it is discarded; it
 * becomes a preamble, because a title is context and this module does not get
 * to decide it is worthless.
 */
function findHeaderRow(rows: readonly string[][], keep: readonly number[]): number {
  const limit = Math.min(rows.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const filled = keep.filter((column) => (rows[index]?.[column] ?? '').trim() !== '').length;
    if (filled >= Math.max(2, Math.ceil(keep.length * 0.6))) return index;
  }
  return 0;
}

/**
 * RFC 4180, and tolerant where real exports are not.
 *
 * A quote only opens a field at the field's start, so an apostrophe or an inch
 * mark in the middle of unquoted prose stays a character instead of swallowing
 * the rest of the file. Inside a quoted field a doubled quote is a literal one,
 * and a newline is content — which is the entire reason this cannot be
 * `split('\n')`, since a numbered list inside one cell is the normal way a
 * tester writes steps.
 */
export function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < input.length) {
    const character = input[index] as string;

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    field += character;
    index += 1;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Whether the text was already destroyed before it got here.
 *
 * A sheet exported to a non-Unicode encoding does not fail — it succeeds, with
 * every character the target encoding could not represent replaced by a literal
 * `?`. The file is then valid, readable CSV whose *content* is gone, and this
 * is the one damage case that cannot be detected any later: the claims, the
 * steps and the run all inherit it while looking exactly like success. It is
 * not recoverable from this file by anyone, which is why the note says what to
 * do rather than only what is wrong.
 *
 * Runs of three or more, so ordinary punctuation — "Is this correct?" — is not
 * mistaken for damage.
 */
function replacementNote(text: string): string {
  const sample = text.slice(0, 8_000);
  if (sample.length < 200) return '';

  const runs = sample.match(/\?{3,}/g) ?? [];
  const damaged = runs.reduce((total, run) => total + run.length, 0);
  const unmappable = (sample.match(/�/g) ?? []).length;
  const ratio = (damaged + unmappable) / sample.length;
  if (ratio <= 0.03) return '';

  return (
    `roughly ${Math.round(ratio * 100)}% of this file is literal "?" characters — the text was ` +
    'replaced when the sheet was exported to a non-Unicode encoding, and it cannot be recovered ' +
    'from this file. Re-export it as "CSV UTF-8" and upload it again'
  );
}

// --- PDF --------------------------------------------------------------------

/**
 * The text layer of a PDF, and nothing else.
 *
 * A PDF's page content is a little stack program; the only operators that put
 * characters on a page are `Tj`, `TJ`, `'` and `"`, and their operands are the
 * strings. Everything else here is positioning, and positioning is where a real
 * renderer's complexity lives — it is skipped, with one concession: the
 * operators that move to a new line (`Td`, `TD`, `T*`) become newlines, because
 * a checklist that arrives as one unbroken line is a checklist a model reads as
 * one claim.
 *
 * What this deliberately does not do: fonts. A PDF may map bytes to glyphs
 * through an arbitrary encoding, and text drawn with such a font comes out as
 * mojibake. That is why `extractDocument` refuses an empty result rather than
 * returning it — a scan and an unmappable font both produce nothing usable, and
 * both deserve to be said out loud instead of silently becoming a test.
 */
function readPdf(bytes: Buffer): { text: string; note: string } {
  const chunks: string[] = [];

  for (const stream of pdfStreams(bytes)) {
    // Only what sits between BT and ET is text. This is the discriminator that
    // keeps a PDF's *other* streams out of the result: an embedded ICC profile
    // or font file inflates just as happily as page content and is full of
    // bytes that look like string operands, so scanning a whole stream turns a
    // three-line checklist into three lines followed by a page of mojibake.
    // Found by extracting a real PDF and reading what came back.
    for (const block of stream.matchAll(/BT\b([\s\S]*?)\bET\b/g)) {
      const text = pdfTextFromContent(block[1] ?? '');
      if (text.trim() !== '') chunks.push(text);
    }
  }

  const text = chunks.join('\n');
  return { text, note: garbledNote(text) };
}

/**
 * Whether the characters look like language.
 *
 * A PDF may map bytes to glyphs through a font-specific encoding, and this
 * extractor does not read fonts — so text drawn with such a font comes back as
 * plausible-looking nonsense rather than as an obvious failure. That is the one
 * outcome here worth warning about explicitly: nonsense reaches the model, the
 * model writes tests about it, and nothing downstream can tell.
 */
function garbledNote(text: string): string {
  const sample = text.slice(0, 4000);
  if (sample.length < 40) return '';
  // Printable ASCII, Latin-1 letters, and the scripts this codebase already
  // expects to meet (Thai, CJK). Anything else is a mapping that went wrong.
  const odd = sample.replace(
    /[\t\n\x20-\x7eÀ-ɏ฀-๿　-ヿ一-鿿‐-›]/g,
    '',
  ).length;
  return odd / sample.length > 0.12
    ? 'some characters may be wrong — this PDF draws text through a custom font encoding, which this extractor does not read. Check the text below before trusting it'
    : '';
}

/** Every stream object's decoded bytes, skipping the ones we cannot inflate. */
function pdfStreams(bytes: Buffer): string[] {
  const out: string[] = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');

  let index = bytes.indexOf(marker);
  while (index !== -1) {
    // The dictionary immediately before this `stream` keyword says how it is
    // encoded; only Flate and raw are handled, and an image is skipped by its
    // subtype rather than by trying and producing noise.
    const dictionaryStart = Math.max(0, index - 800);
    const dictionary = bytes.toString('latin1', dictionaryStart, index);
    const end = bytes.indexOf(endMarker, index);
    if (end === -1) break;

    let start = index + marker.length;
    if (bytes[start] === 0x0d) start += 1;
    if (bytes[start] === 0x0a) start += 1;

    const isImage = /\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dictionary);
    if (!isImage) {
      const raw = bytes.subarray(start, end);
      try {
        out.push(
          /\/FlateDecode/.test(dictionary)
            ? inflateSync(raw).toString('latin1')
            : raw.toString('latin1'),
        );
      } catch {
        // A stream we cannot inflate contributes nothing; it must not stop the
        // rest of the document from being read.
      }
    }

    index = bytes.indexOf(marker, end + endMarker.length);
  }
  return out;
}

/** Text-showing operators, in document order. */
function pdfTextFromContent(content: string): string {
  let out = '';
  let i = 0;

  const readLiteral = (): string => {
    // Starts on '('. Nesting is legal and unescaped parens are common.
    let depth = 1;
    let value = '';
    i += 1;
    while (i < content.length && depth > 0) {
      const character = content[i] as string;
      if (character === '\\') {
        const next = content[i + 1] as string;
        const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))?.[0];
        if (octal !== undefined) {
          value += String.fromCharCode(parseInt(octal, 8));
          i += 1 + octal.length;
          continue;
        }
        value += ESCAPES[next] ?? next;
        i += 2;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      value += character;
      i += 1;
    }
    return value;
  };

  const readHex = (): string => {
    const close = content.indexOf('>', i);
    if (close === -1) {
      i = content.length;
      return '';
    }
    const digits = content.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '');
    i = close + 1;
    let value = '';
    for (let d = 0; d + 1 < digits.length; d += 2) {
      value += String.fromCharCode(parseInt(digits.slice(d, d + 2), 16));
    }
    return value;
  };

  while (i < content.length) {
    const character = content[i] as string;

    if (character === '(') {
      out += readLiteral();
      continue;
    }
    if (character === '<' && content[i + 1] !== '<') {
      out += readHex();
      continue;
    }
    // A negative kern inside a TJ array is usually a space the font does not
    // draw. Small ones are letter spacing and must not become spaces, or every
    // word arrives split.
    if (character === '-' || (character >= '0' && character <= '9')) {
      const number = /^-?\d+(\.\d+)?/.exec(content.slice(i))?.[0];
      if (number !== undefined) {
        if (Number(number) <= -120) out += ' ';
        i += number.length;
        continue;
      }
    }
    if (content.startsWith('Td', i) || content.startsWith('TD', i) || content.startsWith('T*', i)) {
      out += '\n';
      i += 2;
      continue;
    }
    if (content.startsWith('ET', i)) {
      out += '\n';
      i += 2;
      continue;
    }
    i += 1;
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
};
