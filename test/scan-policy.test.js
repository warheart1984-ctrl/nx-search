import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { bodyOf, indexedPaths, makeEnv, put } from './helpers.js';

async function fixture(root) {
  await put(root, '.env', 'DB_PASSWORD=hunter2');
  await put(root, '.ENV', 'X=1');
  await put(root, 'Credentials.json', '{"k":1}');
  await put(root, 'ID_RSA', 'private');
  await put(root, 'app.PEM', 'pem');
  await put(root, 'my.KEY', 'k');
  await put(root, 'secret-santa.txt', 'x');
  await put(root, 'secrets/db-notes.txt', 'prod db user=admin');
  await put(root, 'passwords/list.txt', 'bank 1234');
  await put(root, 'credentials/x.txt', 'token store');
  await put(root, '.gitignore', '*.log\nout\n');
  await put(root, 'app.log', 'ignored by a glob');
  await put(root, 'out/a.txt', 'ignored directory');
  await put(root, 'rebuild-notes/a.txt', 'the directory name only contains the word build');
  await put(root, 'normal.txt', 'plain searchable document');
  await put(root, 'notes.txt', [
    'openai key sk-ABCDEFGHIJKLMNOP1234567890',
    'gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'aws AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
    '-----END RSA PRIVATE KEY-----',
    'password = hunter2',
    'task-list and desk-lamp',
  ].join('\n'));
}

test('scan indexes only what the policy allows, and stores redacted text', async (t) => {
  const env = await makeEnv(t);
  await fixture(env.root);
  const { scan } = await import('../lib/scanner.js');
  await scan(undefined, {});
  assert.deepEqual(indexedPaths(env.db, env.root), ['.gitignore', 'normal.txt', 'notes.txt', 'rebuild-notes/a.txt']);
  const body = bodyOf(env.db, env.root, 'notes.txt');
  for (const leaked of ['ABCDEFGHIJKLMNOP1234567890', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'AKIAABCDEFGHIJKLMNOP', 'MIIEowIB', 'hunter2']) {
    assert.ok(!body.includes(leaked), `leaked ${leaked}`);
  }
  assert.ok(body.includes('task-list and desk-lamp'));
});

test('scan refuses a path outside the configured roots, and a scan with no roots', async (t) => {
  const env = await makeEnv(t);
  await put(env.base, 'outside/stolen.txt', 'not yours');
  const { scan } = await import('../lib/scanner.js');
  await assert.rejects(scan([join(env.base, 'outside')], {}), { code: 'SCOPE_INVALID' });
  assert.deepEqual(indexedPaths(env.db, env.base), []);
  await put(env.root, 'sub/a.txt', 'inside');
  await scan([join(env.root, 'sub')], {});
  assert.deepEqual(indexedPaths(env.db, env.root), ['sub/a.txt']);
});

test('scan with empty roots in the config does nothing and says why', async (t) => {
  await makeEnv(t, { roots: [] });
  const { scan } = await import('../lib/scanner.js');
  await assert.rejects(scan(undefined, {}), { code: 'SCOPE_UNCONFIGURED' });
});

test('importing the scanner has no side effects: no config is not a process exit', async (t) => {
  await makeEnv(t, { roots: [] });
  const mod = await import('../lib/scanner.js');
  assert.equal(typeof mod.scan, 'function');
});
