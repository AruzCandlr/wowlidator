/**
 * Parses every `.tsx`/`.jsx` file with `@babel/parser` (not a regex) and
 * builds `component` nodes plus `uses` edges between them.
 *
 * Babel, not the TypeScript compiler, on purpose: this repo's own `typescript`
 * devDependency is pinned to the v7 native rewrite, whose public surface no
 * longer exposes the classic `createSourceFile`/`forEachChild` API this kind
 * of walk needs — only an early "unstable" service-based API tied to that
 * exact version. A dedicated, stable, synchronous parser that doesn't move
 * whenever the host project's own compiler does is the more defensible
 * choice for something meant to run against arbitrary target repositories.
 *
 * This is syntactic, not type-checked: import specifiers are resolved
 * textually against the files the walk already found. That is accurate for
 * a component imported directly by relative path — the overwhelming common
 * case — but will not follow a re-export through a renaming barrel file, and
 * treats anything imported from a bare specifier (a package, or a path alias
 * like `@/components/Button`) as external and skips it rather than guessing.
 * Understating the graph is the correct failure mode here, same reasoning as
 * `ax-coverage.ts`'s attribution honesty: a wrong edge is worse than a
 * missing one.
 */

import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';

import type { IngestContext, IngestResult, Ingester, ProjectEdge, ProjectNode } from '../types.js';
import { componentId, pascalFromFilename } from '../naming.js';

const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx']);
const RESOLVE_SUFFIXES = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
/** Files beyond this are skipped with a warning — a token/time budget, same spirit as `DEFAULT_MAX_AX_NODES`. */
const MAX_FILES = 1500;

interface ParsedComponent {
  id: string;
  isDefault: boolean;
}

interface ParsedFile {
  file: string;
  components: Map<string, ParsedComponent>;
  imports: Array<{ localName: string; source: string; isDefault: boolean }>;
  usagesByComponent: Map<string, Set<string>>;
}

function isUpper(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isNode(value: unknown): value is t.Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Generic child walk, driven by Babel's own visitor-key table — the `forEachChild` this AST doesn't ship natively. */
function forEachChild(node: t.Node, visit: (child: t.Node) => void): void {
  const keys = (t.VISITOR_KEYS as Record<string, string[] | undefined>)[node.type] ?? [];
  const record = node as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item);
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

function tagRootName(name: t.JSXOpeningElement['name']): string | undefined {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) return tagRootName(name.object);
  return undefined;
}

function collectJsxUsage(node: t.Node, into: Set<string>): void {
  if (t.isJSXOpeningElement(node)) {
    const tagName = tagRootName(node.name);
    if (tagName && isUpper(tagName)) into.add(tagName);
  }
  forEachChild(node, (child) => collectJsxUsage(child, into));
}

/** Registers an uppercase-named function/const-arrow declaration as a component candidate, exported or not. */
function registerDeclaration(node: t.Node, candidates: Map<string, t.Node>): void {
  if (t.isFunctionDeclaration(node) && node.id && isUpper(node.id.name)) {
    candidates.set(node.id.name, node.body);
    return;
  }
  if (t.isVariableDeclaration(node)) {
    for (const decl of node.declarations) {
      if (
        t.isIdentifier(decl.id) &&
        isUpper(decl.id.name) &&
        decl.init &&
        (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init))
      ) {
        candidates.set(decl.id.name, decl.init.body);
      }
    }
  }
}

function declaredUpperNames(node: t.Node): string[] {
  if (t.isFunctionDeclaration(node) && node.id && isUpper(node.id.name)) return [node.id.name];
  if (t.isVariableDeclaration(node)) {
    return node.declarations
      .filter((decl): decl is t.VariableDeclarator & { id: t.Identifier } => t.isIdentifier(decl.id))
      .map((decl) => decl.id.name)
      .filter(isUpper);
  }
  return [];
}

/** Syntactic single-file parse: which uppercase-named things are exported, and what JSX each one renders. */
function parseFile(file: string, text: string): ParsedFile {
  const ast = parse(text, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });

  const candidates = new Map<string, t.Node>();
  const exportedNames = new Set<string>();
  const imports: Array<{ localName: string; source: string; isDefault: boolean }> = [];
  let defaultName: string | undefined;

  // Pass 1: every uppercase function/const-arrow at the top level, exported or not — a later
  // `export default Foo;` may reference a declaration that appears anywhere in the file.
  for (const node of ast.program.body) {
    if (t.isFunctionDeclaration(node) || t.isVariableDeclaration(node)) {
      registerDeclaration(node, candidates);
    } else if (t.isExportNamedDeclaration(node) && node.declaration) {
      registerDeclaration(node.declaration, candidates);
    } else if (
      t.isExportDefaultDeclaration(node) &&
      (t.isFunctionDeclaration(node.declaration) || t.isVariableDeclaration(node.declaration))
    ) {
      registerDeclaration(node.declaration, candidates);
    }
  }

  // Pass 2: imports, plus which candidates are actually exported / the default.
  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node)) {
      const source = node.source.value;
      for (const spec of node.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          imports.push({ localName: spec.local.name, source, isDefault: true });
        } else if (t.isImportSpecifier(spec)) {
          imports.push({ localName: spec.local.name, source, isDefault: false });
        }
      }
      continue;
    }

    if (t.isExportNamedDeclaration(node) && node.declaration) {
      for (const name of declaredUpperNames(node.declaration)) exportedNames.add(name);
      continue;
    }

    if (t.isExportDefaultDeclaration(node)) {
      const decl = node.declaration;
      if (t.isFunctionDeclaration(decl)) {
        const name = decl.id ? decl.id.name : pascalFromFilename(file);
        if (!candidates.has(name)) candidates.set(name, decl.body);
        defaultName = name;
      } else if (t.isIdentifier(decl) && candidates.has(decl.name)) {
        defaultName = decl.name;
      } else if (t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
        const synthetic = pascalFromFilename(file);
        candidates.set(synthetic, decl.body);
        defaultName = synthetic;
      }
      continue;
    }
  }

  if (defaultName) exportedNames.add(defaultName);

  const components = new Map<string, ParsedComponent>();
  const usagesByComponent = new Map<string, Set<string>>();
  for (const name of exportedNames) {
    const body = candidates.get(name);
    if (!body) continue;
    components.set(name, { id: componentId(file, name), isDefault: name === defaultName });
    const usages = new Set<string>();
    collectJsxUsage(body, usages);
    usagesByComponent.set(name, usages);
  }

  return { file, components, imports, usagesByComponent };
}

/** Resolve a relative import specifier against the set of files this walk actually parsed. */
function resolveImportFile(fromFile: string, source: string, known: ReadonlySet<string>): string | undefined {
  if (!source.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(fromFile), source));
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${target}${suffix}`;
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

function posixExtname(file: string): string {
  const dot = file.lastIndexOf('.');
  const slash = file.lastIndexOf('/');
  return dot > slash ? file.slice(dot) : '';
}

export class ComponentIngester implements Ingester {
  readonly id = 'component';

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const warnings: string[] = [];
    const candidateFiles = ctx.files.filter((file) => COMPONENT_EXTENSIONS.has(posixExtname(file)));

    const truncated = candidateFiles.length > MAX_FILES;
    const targets = truncated ? candidateFiles.slice(0, MAX_FILES) : candidateFiles;
    if (truncated) {
      warnings.push(
        `${candidateFiles.length} component files found, only indexing the first ${MAX_FILES}`,
      );
    }

    const parsed = new Map<string, ParsedFile>();
    for (const file of targets) {
      try {
        const text = await readFile(posix.join(ctx.rootDir, file), 'utf8');
        parsed.set(file, parseFile(file, text));
      } catch (error) {
        warnings.push(`could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const known = new Set(parsed.keys());
    const nodes: ProjectNode[] = [];
    const edges: ProjectEdge[] = [];

    for (const entry of parsed.values()) {
      for (const [name, component] of entry.components) {
        nodes.push({
          id: component.id,
          kind: 'component',
          name,
          file: entry.file,
          meta: { default: String(component.isDefault) },
        });

        const usages = entry.usagesByComponent.get(name) ?? new Set<string>();
        for (const tag of usages) {
          const viaImport = entry.imports.find((imp) => imp.localName === tag);

          if (viaImport) {
            const targetFile = resolveImportFile(entry.file, viaImport.source, known);
            if (!targetFile) continue; // external package or path alias — not ours to resolve
            const targetEntry = parsed.get(targetFile);
            if (!targetEntry) continue;

            const targetComponent = viaImport.isDefault
              ? [...targetEntry.components.values()].find((c) => c.isDefault)
              : targetEntry.components.get(tag);
            if (targetComponent) edges.push({ from: component.id, to: targetComponent.id, kind: 'uses' });
            continue;
          }

          // No import for this tag — check whether it's a sibling component defined in the same file.
          const local = entry.components.get(tag);
          if (local) edges.push({ from: component.id, to: local.id, kind: 'uses' });
        }
      }
    }

    return { nodes, edges, warnings };
  }
}
