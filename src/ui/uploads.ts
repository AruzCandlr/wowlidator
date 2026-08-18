/**
 * Documents the panel accepts: catalogs, and the context that supports them.
 *
 * Two kinds, and they are kept in two directories because they are two
 * different claims about a file:
 *
 *   `.wowlidator/catalogs/`      a document of things that must be true. This
 *                                becomes claims, and then a test.
 *   `.wowlidator/context-docs/`  background. It asserts nothing and is never
 *                                a source of claims; it is there so the model
 *                                knows what a term in the catalog means.
 *
 * Collapsing them into one directory would be tidier and wrong: the whole
 * value of the separation is that a model told "this is background" does not
 * write tests about the API documentation.
 *
 * ## What arrives here
 *
 * A file from a browser file picker, base64'd, or text someone typed. Three
 * rules, all of which exist because this writes to disk on behalf of a page:
 *
 * - **The name is rebuilt, never used.** Only the extension is taken from what
 *   the browser sent, and only if it is one this framework can read; the stem
 *   is slugified. `../../.ssh/authorized_keys` cannot survive that, and neither
 *   can a name that merely collides with something already there.
 * - **The extension decides, not the bytes.** An upload whose extension is not
 *   in the supported list is refused rather than sniffed — the same
 *   understate-never-overstate rule the extractor applies.
 * - **Size is capped before decode**, because base64 of a huge file is a memory
 *   problem before it is a disk one.
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { DIAGRAM_IMAGE_EXTENSIONS, isDiagramImage } from '../catalog/diagram-image.js';
import { MAX_FILE_BYTES, SUPPORTED_EXTENSIONS, formatFor } from '../catalog/extract.js';

export const CATALOG_DIR = '.wowlidator/catalogs';
export const CONTEXT_DOC_DIR = '.wowlidator/context-docs';

export type UploadKind = 'catalog' | 'context';

export class UploadError extends Error {}

export interface StoredDocument {
  name: string;
  path: string;
  bytes: number;
  modified: string;
  /** What the extractor will treat it as, so the UI can say so before a run. */
  format: string;
}

export function directoryFor(kind: UploadKind): string {
  return resolve(kind === 'catalog' ? CATALOG_DIR : CONTEXT_DOC_DIR);
}

/**
 * A file name that is only a file name.
 *
 * Everything except the extension is rewritten. A browser can send any string
 * as a file name — including one full of separators — and this is the one
 * place that string would otherwise reach a path.
 */
export function safeName(rawName: string, fallbackExtension = '.txt'): string {
  const name = basename(String(rawName ?? '')).trim();
  const extension = extname(name).toLowerCase();
  const usable =
    SUPPORTED_EXTENSIONS.includes(extension) || DIAGRAM_IMAGE_EXTENSIONS.includes(extension)
      ? extension
      : fallbackExtension;

  const stem = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/[\s.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${stem === '' ? 'document' : stem}${usable}`;
}

export interface SaveRequest {
  kind: UploadKind;
  name: string;
  /** Base64 for a picked file. Mutually exclusive with `text`. */
  contentBase64?: string | undefined;
  /** Typed straight into the panel. Saved as `.md` unless the name says otherwise. */
  text?: string | undefined;
}

export async function saveDocument(request: SaveRequest): Promise<StoredDocument> {
  if (request.kind !== 'catalog' && request.kind !== 'context') {
    throw new UploadError(`unknown document kind "${String(request.kind)}"`);
  }

  let bytes: Buffer;
  if (typeof request.contentBase64 === 'string') {
    // Base64 is 4 characters per 3 bytes; checking the encoded length first
    // means a 100MB upload is refused before it is ever materialised.
    if (request.contentBase64.length / 4 * 3 > MAX_FILE_BYTES) {
      throw new UploadError(`that file is larger than ${MAX_FILE_BYTES / 1024 / 1024}MB`);
    }
    bytes = Buffer.from(request.contentBase64, 'base64');
  } else if (typeof request.text === 'string') {
    bytes = Buffer.from(request.text, 'utf8');
  } else {
    throw new UploadError('nothing to save — send either a file or some text');
  }

  if (bytes.byteLength === 0) throw new UploadError('that document is empty');

  const name = safeName(request.name, typeof request.text === 'string' ? '.md' : '.txt');
  // A diagram image is a catalog input only: the catalog command transcribes
  // it with a vision model before the deterministic path runs. As a context
  // document it would reach the extractor directly, which reads no pixels —
  // refuse at upload, before the error can happen three steps later.
  if (isDiagramImage(name)) {
    if (request.kind !== 'catalog') {
      throw new UploadError(
        'a diagram image can only be a catalog — context documents are text the model reads directly',
      );
    }
  } else if (formatFor(name) === undefined) {
    throw new UploadError(
      `wowlidator cannot read "${request.name}" — it reads ${SUPPORTED_EXTENSIONS.join(' ')} (and ${DIAGRAM_IMAGE_EXTENSIONS.join(' ')} as a sequence-diagram catalog)`,
    );
  }

  const dir = directoryFor(request.kind);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);

  const info = await stat(path);
  return {
    name,
    path,
    bytes: info.size,
    modified: info.mtime.toISOString(),
    format: formatFor(name) ?? (isDiagramImage(name) ? 'sequence-image' : 'text'),
  };
}

export async function listDocuments(kind: UploadKind): Promise<StoredDocument[]> {
  const dir = directoryFor(kind);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const documents: StoredDocument[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const format =
      formatFor(entry.name) ?? (isDiagramImage(entry.name) ? ('sequence-image' as const) : undefined);
    if (format === undefined) continue;
    const path = join(dir, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    documents.push({
      name: entry.name,
      path,
      bytes: info.size,
      modified: info.mtime.toISOString(),
      format,
    });
  }
  return documents.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Remove one document the panel itself stored.
 *
 * The check is not "is this inside a root the panel may read" — it is "is this
 * a file the panel put in its own document directory". Deletion is the one
 * operation here that destroys something, so it gets the narrowest rule in the
 * server rather than the general one: a name, in one known directory, with a
 * readable extension.
 */
export async function deleteDocument(kind: UploadKind, path: string): Promise<void> {
  const dir = directoryFor(kind);
  const target = resolve(path);
  if (resolve(join(dir, basename(target))) !== target) {
    throw new UploadError('that path is not a document this panel stored');
  }
  if (formatFor(target) === undefined && !isDiagramImage(target)) {
    throw new UploadError('that is not a document this panel stored');
  }
  await unlink(target);
}
