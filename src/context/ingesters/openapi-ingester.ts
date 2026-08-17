/**
 * Indexes an OpenAPI / Swagger document into `operation` nodes.
 *
 * This is the backend half of what the AX tree does for a page. Generating UI
 * tests works because the AX tree is a real inventory of the controls that
 * exist — the model is choosing among facts, not inventing selectors. A spec
 * is exactly that for endpoints: methods, paths, parameters, request and
 * response shapes, auth. Without one, generating API tests would be guessing
 * at URLs, which is the one thing this codebase has consistently refused to do.
 *
 * Like every other ingester it makes **no model call** — parsing a document is
 * not reasoning. It also does not fetch anything at index time unless the
 * caller passed a URL, and the whole ingester degrades to a warning rather
 * than an exception, same as the other four.
 *
 * Disclosed gaps, not silent ones:
 * - `$ref` is resolved **within a single document only**. A `$ref` pointing at
 *   another file or a remote URL is recorded as unresolved rather than guessed
 *   at or silently dropped.
 * - Swagger 2.0 `definitions`/`parameters` are read, but its `body` parameter
 *   convention is normalised into an OpenAPI-3-style request body summary
 *   rather than modelled faithfully.
 * - Callbacks, links, and `oneOf`/`anyOf` discriminators are not modelled.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { IngestContext, IngestResult, Ingester, ProjectNode } from '../types.js';

/** Filenames treated as a spec when no explicit source is configured. */
const SPEC_FILE_RE = /(^|\/)(openapi|swagger)\.(json|ya?ml)$/i;

/** HTTP methods an OpenAPI path item may carry. */
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Depth cap for `$ref` chains — a self-referential schema must not hang a build. */
const MAX_REF_DEPTH = 8;

/** How much of a schema to summarise. Whole schemas can be enormous. */
const MAX_SCHEMA_PROPS = 12;

interface SpecDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url?: string }>;
  host?: string;
  basePath?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  definitions?: Record<string, unknown>;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: unknown[];
}

export interface OpenApiIngesterOptions {
  /**
   * Explicit spec location — a path (absolute, or relative to the project
   * root) or an `http(s)` URL. When omitted, the ingester looks for
   * `openapi.*` / `swagger.*` among the files already walked.
   */
  source?: string | undefined;
  /** Timeout for fetching a spec by URL. */
  timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// `toRoutePattern` moved to `route-match.ts` with the matcher it exists for;
// re-exported here so existing imports of this module keep working.
export { toRoutePattern } from '../route-match.js';
import { toRoutePattern } from '../route-match.js';

/** Resolve a local `#/components/schemas/Foo` reference. Returns null otherwise. */
function resolveRef(document: SpecDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) return null; // external or remote — a disclosed gap
  let current: unknown = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    // JSON Pointer escaping: ~1 is "/", ~0 is "~".
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return current ?? null;
}

function deref(document: SpecDocument, value: unknown, depth = 0): unknown {
  if (depth > MAX_REF_DEPTH || !isRecord(value)) return value;
  const ref = asString(value['$ref']);
  if (ref === undefined) return value;
  const target = resolveRef(document, ref);
  if (target === null) return { unresolvedRef: ref };
  return deref(document, target, depth + 1);
}

/**
 * One-line summary of a schema.
 *
 * A summary rather than the schema itself: these end up in a prompt and in a
 * graph file, and a deeply nested schema would blow the token budget the same
 * way an unpruned AX tree would.
 */
function summariseSchema(document: SpecDocument, raw: unknown, depth = 0): string {
  const schema = deref(document, raw, depth);
  if (!isRecord(schema)) return 'unknown';
  if (asString(schema['unresolvedRef'])) return `unresolved ref ${asString(schema['unresolvedRef'])}`;

  const type = asString(schema['type']);
  if (type === 'array') {
    const items = depth >= 2 ? '…' : summariseSchema(document, schema['items'], depth + 1);
    return `${items}[]`;
  }

  const properties = schema['properties'];
  if (isRecord(properties)) {
    const required = new Set(
      Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : [],
    );
    const names = Object.keys(properties);
    const shown = names.slice(0, MAX_SCHEMA_PROPS).map((name) => {
      const inner = deref(document, properties[name], depth + 1);
      const innerType = isRecord(inner) ? (asString(inner['type']) ?? 'any') : 'any';
      return `${name}${required.has(name) ? '' : '?'}: ${innerType}`;
    });
    const more = names.length > shown.length ? `, +${names.length - shown.length} more` : '';
    return `{ ${shown.join(', ')}${more} }`;
  }

  return type ?? 'unknown';
}

function summariseParameters(document: SpecDocument, raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const parts: string[] = [];
  for (const entry of raw) {
    const parameter = deref(document, entry);
    if (!isRecord(parameter)) continue;
    const name = asString(parameter['name']);
    if (name === undefined) continue;
    const location = asString(parameter['in']) ?? 'query';
    // Swagger 2.0 puts a body parameter in the same list as query/path ones.
    if (location === 'body') continue;
    parts.push(`${location}:${name}${parameter['required'] === true ? '' : '?'}`);
  }
  return parts.join(' ');
}

function summariseRequestBody(document: SpecDocument, operation: OperationObject): string {
  const body = deref(document, operation.requestBody);
  if (isRecord(body)) {
    const content = body['content'];
    if (isRecord(content)) {
      const [mediaType, media] = Object.entries(content)[0] ?? [];
      if (mediaType && isRecord(media)) {
        return `${mediaType} ${summariseSchema(document, media['schema'])}`;
      }
    }
  }
  // Swagger 2.0 shape.
  if (Array.isArray(operation.parameters)) {
    for (const entry of operation.parameters) {
      const parameter = deref(document, entry);
      if (isRecord(parameter) && parameter['in'] === 'body') {
        return `application/json ${summariseSchema(document, parameter['schema'])}`;
      }
    }
  }
  return '';
}

function summariseResponses(document: SpecDocument, operation: OperationObject): string {
  if (!isRecord(operation.responses)) return '';
  return Object.entries(operation.responses)
    .map(([status, raw]) => {
      const response = deref(document, raw);
      const description = isRecord(response) ? (asString(response['description']) ?? '') : '';
      return `${status}${description ? ` ${description}` : ''}`;
    })
    .join(' · ');
}

/** The status codes a spec says are possible — what a generated test asserts on. */
function statusList(operation: OperationObject): string {
  if (!isRecord(operation.responses)) return '';
  return Object.keys(operation.responses)
    .filter((status) => /^\d{3}$/.test(status))
    .join(',');
}

function serverUrl(document: SpecDocument): string | undefined {
  const fromServers = document.servers?.[0]?.url;
  if (asString(fromServers)) return fromServers;
  // Swagger 2.0.
  if (document.host) return `https://${document.host}${document.basePath ?? ''}`;
  return document.basePath ?? undefined;
}

export class OpenApiIngester implements Ingester {
  readonly id = 'openapi';
  readonly #source: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: OpenApiIngesterOptions = {}) {
    this.#source = options.source;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const nodes: ProjectNode[] = [];
    const warnings: string[] = [];

    const located = this.#locate(ctx);
    if (located === undefined) {
      // Not a warning: most projects have no spec, and saying so on every
      // `context build` would train people to ignore the warnings that matter.
      return { nodes, edges: [], warnings };
    }

    let document: SpecDocument;
    try {
      document = await this.#load(located, ctx.rootDir);
    } catch (error) {
      warnings.push(
        `could not read the OpenAPI spec at ${located}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { nodes, edges: [], warnings };
    }

    if (!isRecord(document.paths)) {
      warnings.push(`${located} has no "paths" object — is it an OpenAPI document?`);
      return { nodes, edges: [], warnings };
    }

    const base = serverUrl(document);
    const version = document.openapi ?? document.swagger ?? 'unknown';

    for (const [path, rawItem] of Object.entries(document.paths)) {
      const item = deref(document, rawItem);
      if (!isRecord(item)) continue;

      for (const method of METHODS) {
        const raw = item[method];
        if (!isRecord(raw)) continue;
        const operation = raw as OperationObject;

        // Path-level parameters apply to every operation under that path.
        const parameters = [
          ...(Array.isArray(item['parameters']) ? item['parameters'] : []),
          ...(operation.parameters ?? []),
        ];

        const upper = method.toUpperCase();
        const meta: Record<string, string> = {
          method: upper,
          path,
          spec: located,
          specVersion: version,
        };
        const set = (key: string, value: string): void => {
          if (value !== '') meta[key] = value;
        };
        set('base', base ?? '');
        set('operationId', operation.operationId ?? '');
        set('tags', (operation.tags ?? []).join(','));
        set('parameters', summariseParameters(document, parameters));
        set('requestBody', summariseRequestBody(document, { ...operation, parameters }));
        set('responses', summariseResponses(document, operation));
        set('statuses', statusList(operation));
        if (operation.deprecated === true) meta['deprecated'] = 'true';
        if (Array.isArray(operation.security) && operation.security.length > 0) {
          meta['secured'] = 'true';
        }

        nodes.push({
          id: `operation:${upper} ${path}`,
          kind: 'operation',
          // The `:param` form, so route-pattern matching works on it unchanged.
          name: `${upper} ${toRoutePattern(path)}`,
          file: located,
          detail: operation.summary ?? operation.description ?? undefined,
          meta,
        });
      }
    }

    if (nodes.length === 0) warnings.push(`${located} declared no operations`);

    return { nodes, edges: [], warnings };
  }

  /** An explicit source wins; otherwise look for a conventional filename. */
  #locate(ctx: IngestContext): string | undefined {
    if (this.#source !== undefined) return this.#source;
    // Shallowest match wins — a root-level `openapi.yaml` beats a fixture copy
    // buried in a test directory.
    const candidates = ctx.files.filter((file) => SPEC_FILE_RE.test(file));
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    return candidates[0];
  }

  async #load(source: string, rootDir: string): Promise<SpecDocument> {
    const text = /^https?:\/\//i.test(source)
      ? await this.#fetch(source)
      : await readFile(isAbsolute(source) ? source : resolvePath(rootDir, posix.normalize(source)), 'utf8');

    // `yaml`'s parser accepts JSON too (JSON is a YAML subset), but parsing
    // JSON with `JSON.parse` keeps the error messages precise for the common
    // case and avoids YAML's own quirks (e.g. duplicate-key handling).
    const parsed: unknown = /\.ya?ml$/i.test(source) ? parseYaml(text) : safeJson(text);
    if (!isRecord(parsed)) throw new Error('spec did not parse to an object');
    return parsed as SpecDocument;
  }

  async #fetch(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response.text();
  }
}

/** JSON first, YAML as the fallback — some specs are served without an extension. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text);
  }
}
