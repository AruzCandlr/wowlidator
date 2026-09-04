/**
 * The two-persona benchmark's application: a miniature of the live one, in one
 * file with no dependencies.
 *
 * It exists because nothing else does. Every `.flow.json` in this repository
 * signs in exactly once, so a change to persona switching — the browser lease,
 * the session guard's per-persona memory, the agent's replay scope — had no
 * before/after to be measured against. This is that missing row, and it costs
 * nothing to run: no real application, no credentials, no model, no network.
 *
 * The shape is taken verbatim from the fixture in `tests/session-bootstrap.ts`
 * so the benchmark and the CDP-gated tests are measuring the same application:
 *
 *   - a TWO-SCREEN login (email + Next, then password), which is the shape the
 *     live failure came from;
 *   - a session cookie that carries WHICH account signed in, so a page can be
 *     asserted against the identity rather than merely against being signed in;
 *   - a protected page that bounces to /login without one;
 *   - sign-out behind an ARIA-marked disclosure, invisible until it opens.
 *
 *   node examples/two-persona/server.mjs            # http://127.0.0.1:3210
 *   PORT=4000 node examples/two-persona/server.mjs
 *
 * Both accounts share the password `pw2026`; any email is accepted, so the
 * personas a run declares are the only thing that decides who is signed in.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env['PORT'] ?? 3210);
const PASSWORD = 'pw2026';

const PAGE = (body) => `<!doctype html><html><head><title>fixture</title></head><body>${body}</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const cookie = req.headers.cookie ?? '';
  const who = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1] ?? null;

  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        const email = params.get('email') ?? '';
        if (params.get('password') === PASSWORD && email !== '') {
          res.writeHead(302, { 'set-cookie': `session=${encodeURIComponent(email)}; Path=/`, location: '/app' });
        } else {
          res.writeHead(302, { location: '/login' });
        }
        res.end();
      });
      return;
    }
    if (url.searchParams.get('step') === '2') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        PAGE(
          '<form method="post" action="/login">' +
            `<input type="hidden" name="email" value="${url.searchParams.get('email') ?? ''}">` +
            '<input type="password" name="password">' +
            '<button type="submit">Sign in</button></form>',
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      PAGE(
        '<form method="get" action="/login"><input type="hidden" name="step" value="2">' +
          '<input type="email" name="email">' +
          '<button type="submit">Next</button></form>',
      ),
    );
    return;
  }

  if (url.pathname === '/app') {
    if (who === null) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      PAGE(
        `<h1>Benefit Plans</h1><p id="who">Signed in as ${decodeURIComponent(who)}</p>` +
          '<button aria-haspopup="menu" aria-expanded="false" ' +
          'onclick="document.getElementById(\'m\').style.display=\'block\'">Account</button>' +
          '<div id="m" role="menu" style="display:none">' +
          '<a role="menuitem" href="/logout">Sign out</a></div>',
      ),
    );
    return;
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/login' });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`two-persona fixture on http://127.0.0.1:${PORT} (password ${PASSWORD})\n`);
});
