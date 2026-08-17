/**
 * `wowlidator go` — the one-command dispatch. Split out of cli.ts verbatim.
 */

import { EXIT } from '../exit.js';
import type { CliOptions } from '../options.js';
import { cmdAuthor, cmdGenerate } from './authoring.js';
import { cmdRun } from './run.js';

/**
 * One command from nothing to a report — what you pass decides what happens.
 *
 * The dispatch `wowlidator.sh` used to do, with the same three shapes, because the
 * shape of the argument really is enough: a `.json` is a test, a URL is a page
 * to explore, anything else is a description of a test you want written.
 */
export async function cmdGo(target: string | undefined, options: CliOptions): Promise<number> {
  if (!target) {
    process.stderr.write(
      'wowlidator go: missing target.\n\n' +
        '  wowlidator go <flow.json>              run an existing test\n' +
        '  wowlidator go <url>                    let wowlidator write tests for a page\n' +
        '  wowlidator go "<what to test>" --url <url>   describe a test, write it, run it\n',
    );
    return EXIT.usage;
  }

  if (target.endsWith('.json')) return cmdRun(target, options);
  if (/^https?:\/\//.test(target)) return cmdGenerate(target, { ...options, run: true });

  if (!options.url) {
    process.stderr.write(
      `wowlidator go: describing a test needs a page to check it against:\n\n` +
        `  wowlidator go "${target}" --url http://localhost:3000/your/page\n\n` +
        'Without --url wowlidator has never seen your app, so every selector would be a\n' +
        'guess. Pass the page and it will only use controls that really exist.\n',
    );
    return EXIT.usage;
  }
  return cmdAuthor(target, { ...options, run: true });
}
