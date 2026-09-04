/**
 * The panel's Personas field (CG-05, multi-browser personas): `LABEL=email:
 * password` lines become the `WOWLIDATOR_PERSONAS` JSON map the CLI reads —
 * the same splits as `--persona`, refused rather than dropped when malformed,
 * and never argv. Pure: the spec and the overlay builder need no server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMMANDS, buildArgv, buildEnvOverlay, personasFieldToMap, personasValueToMap } from '../src/ui/commands.js';
import { parsePersonas } from '../src/cli/options.js';

describe('the Personas field', () => {
  it('turns LABEL=email:password lines into the map, labels normalised like the CLI', () => {
    const map = personasFieldToMap('<employee account>=emp@x.test:pw:with:colons\nMANAGER_ACCOUNT = mgr@x.test:pw2; hr-admin=hr@x.test:pw3');
    assert.deepEqual(map, {
      EMPLOYEE_ACCOUNT: { email: 'emp@x.test', password: 'pw:with:colons' },
      MANAGER_ACCOUNT: { email: 'mgr@x.test', password: 'pw2' },
      HR_ADMIN: { email: 'hr@x.test', password: 'pw3' },
    });
  });

  it('refuses a malformed entry with the reason rather than dropping it', () => {
    assert.throws(() => personasFieldToMap('MANAGER_ACCOUNT=mgr@x.test'), /both halves present/);
    assert.throws(() => personasFieldToMap('mgr@x.test:pw'), /LABEL=email:password/);
    assert.throws(() => personasFieldToMap('  ;  '), /no LABEL=email:password entries/);
  });

  it('lands in WOWLIDATOR_PERSONAS as JSON the CLI parses, and never in argv', () => {
    const spec = COMMANDS.find((c) => c.id === 'run')!;
    const values = { flow: 'x.flow.json', personas: 'EMPLOYEE_ACCOUNT=emp@x.test:pw; MANAGER_ACCOUNT=mgr@x.test:pw2' };
    const env = buildEnvOverlay(spec, values);
    const parsed = parsePersonas(undefined, { WOWLIDATOR_PERSONAS: env['WOWLIDATOR_PERSONAS'] });
    assert.ok(parsed.ok);
    assert.equal(parsed.personas['MANAGER_ACCOUNT']?.email, 'mgr@x.test');
    assert.ok(!buildArgv(spec, values).join(' ').includes('mgr@x.test'));
  });

  it('takes the launcher\'s per-account record as well as the typed lines', () => {
    // The launcher collects one email and one password box per detected
    // account, so it sends a record. That is not a convenience: the text form
    // splits on /[\n;]+/ and then on the first ':', so a password containing a
    // semicolon or a newline is silently corrupted on that path — survivable
    // in a box someone typed and watched, not survivable in a form that
    // collects several accounts at once and cannot show what it mangled.
    const gnarly = 'p;w\nith:every#thing';
    const map = personasValueToMap({
      '<manager account>': { email: ' mgr@x.test ', password: gnarly },
      HRBP_ACCOUNT: { email: 'hrbp@x.test', password: 'plain' },
    });
    assert.deepEqual(map, {
      MANAGER_ACCOUNT: { email: 'mgr@x.test', password: gnarly },
      HRBP_ACCOUNT: { email: 'hrbp@x.test', password: 'plain' },
    });

    // …and it survives the whole way to what the CLI actually reads.
    const spec = COMMANDS.find((c) => c.id === 'catalog-run')!;
    const values = {
      catalog: 'cases.xlsx',
      claims: 'c.json',
      url: 'http://x.test',
      personas: { MANAGER_ACCOUNT: { email: 'mgr@x.test', password: gnarly } },
    };
    const env = buildEnvOverlay(spec, values);
    const parsed = parsePersonas(undefined, { WOWLIDATOR_PERSONAS: env['WOWLIDATOR_PERSONAS'] });
    assert.ok(parsed.ok);
    assert.equal(parsed.personas['MANAGER_ACCOUNT']?.password, gnarly, 'byte for byte');
    // What the text path does with the same password, measured — and the
    // second shape is why the record path had to exist: not an error, a
    // plausible-looking wrong answer.
    assert.throws(() => personasFieldToMap(`MANAGER_ACCOUNT=mgr@x.test:${gnarly}`), /each entry must be LABEL=email:password/);
    assert.deepEqual(personasFieldToMap('A_ACCOUNT=a@x.test:p;B_ACCOUNT=b@x.test:q'), {
      // A's password was `p;B_ACCOUNT=b@x.test:q`. It is now `p`, and there is
      // an account B the person never entered.
      A_ACCOUNT: { email: 'a@x.test', password: 'p' },
      B_ACCOUNT: { email: 'b@x.test', password: 'q' },
    });

    // Neither half reaches argv, on the command the launcher actually fires.
    const argv = buildArgv(spec, values).join(' ');
    assert.ok(!argv.includes('mgr@x.test'));
    assert.ok(!argv.includes('p;w'));
  });

  it('refuses an incomplete account rather than dropping it, and treats no accounts as not supplied', () => {
    // A persona silently absent is a run that dies at its second sign-in —
    // the exact failure this field exists to end.
    assert.throws(() => personasValueToMap({ MANAGER_ACCOUNT: { email: 'mgr@x.test', password: '' } }), /missing its password/);
    assert.throws(() => personasValueToMap({ MANAGER_ACCOUNT: { email: '', password: 'p' } }), /missing its email/);
    assert.throws(() => personasValueToMap({ MANAGER_ACCOUNT: 'mgr@x.test:pw' }), /must have an email and a password/);
    assert.throws(() => personasValueToMap([{ email: 'a', password: 'b' }]), /must be text or one entry per account/);

    // An empty record is "not supplied", like an empty box: the form sends the
    // accounts it has, and a catalog whose personas are all in the machine's
    // own environment sends none.
    const spec = COMMANDS.find((c) => c.id === 'catalog-run')!;
    const env = buildEnvOverlay(spec, { catalog: 'cases.xlsx', claims: 'c.json', url: 'http://x.test', personas: {} });
    assert.equal(env['WOWLIDATOR_PERSONAS'], undefined);
  });
});
