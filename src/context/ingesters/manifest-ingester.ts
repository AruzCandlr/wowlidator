/**
 * Reads `package.json`, `tsconfig.json`, and `README.md` into one `package`
 * node — the graph's root. Every other node exists to answer "part of what?",
 * and this is the answer.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IngestContext, IngestResult, Ingester, ProjectNode } from '../types.js';

/** Dependency name → human label, used to tag which UI framework(s) are in play. */
const FRAMEWORK_MARKERS: Array<{ pkg: string; label: string }> = [
  { pkg: 'react', label: 'react' },
  { pkg: 'next', label: 'next.js' },
  { pkg: 'vue', label: 'vue' },
  { pkg: 'nuxt', label: 'nuxt' },
  { pkg: '@angular/core', label: 'angular' },
  { pkg: 'svelte', label: 'svelte' },
  { pkg: 'tailwindcss', label: 'tailwind' },
];

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

/** First `# Heading` line in a README, used as a fallback description. */
function readmeHeading(readme: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(readme);
  return match?.[1];
}

export class ManifestIngester implements Ingester {
  readonly id = 'manifest';

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const warnings: string[] = [];
    const pkgPath = 'package.json';

    if (!ctx.files.includes(pkgPath)) {
      warnings.push('no package.json at the repository root — skipping manifest ingestion');
      return { nodes: [], edges: [], warnings };
    }

    let pkg: PackageJsonShape;
    try {
      pkg = JSON.parse(await readFile(join(ctx.rootDir, pkgPath), 'utf8')) as PackageJsonShape;
    } catch (error) {
      warnings.push(`could not parse package.json: ${error instanceof Error ? error.message : String(error)}`);
      return { nodes: [], edges: [], warnings };
    }

    const deps = { ...asStringRecord(pkg.dependencies), ...asStringRecord(pkg.devDependencies) };
    const frameworks = FRAMEWORK_MARKERS.filter((marker) => deps[marker.pkg] !== undefined).map(
      (marker) => marker.label,
    );

    let description = typeof pkg.description === 'string' ? pkg.description : '';
    if (description === '' && ctx.files.includes('README.md')) {
      try {
        const readme = await readFile(join(ctx.rootDir, 'README.md'), 'utf8');
        description = readmeHeading(readme) ?? '';
      } catch {
        // README present in the walk but unreadable by the time we get here — not fatal.
      }
    }

    const hasTsconfig = ctx.files.includes('tsconfig.json');

    const node: ProjectNode = {
      id: 'package:root',
      kind: 'package',
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : 'project',
      file: pkgPath,
      detail: description === '' ? undefined : description,
      meta: {
        version: typeof pkg.version === 'string' ? pkg.version : '',
        frameworks: frameworks.join(','),
        dependencyCount: String(Object.keys(deps).length),
        typescript: String(hasTsconfig),
      },
    };

    return { nodes: [node], edges: [], warnings };
  }
}
