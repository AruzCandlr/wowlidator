/**
 * Shared id/name conventions between the component and route ingesters.
 *
 * Kept in one place because correctness, not just style, depends on it: a
 * route's guessed "renders" target must land on the exact same node id the
 * component ingester derived from the same file, or the edge dangles (which
 * `ContextEngine` prunes — the safe failure, never a wrong edge).
 */

export function componentId(file: string, name: string): string {
  return `component:${file}#${name}`;
}

/** PascalCase guess for an anonymous default export, derived from its filename. */
export function pascalFromFilename(file: string): string {
  const base = file.split('/').pop() ?? file;
  const stem = base.replace(/\.(tsx|jsx|ts|js)$/, '');
  const name = stem
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return name === '' ? 'Default' : name;
}
