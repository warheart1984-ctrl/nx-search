import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
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

test('paths are stored as the user gave them, even when the root is reached through a link', { skip: process.platform === 'win32' }, async (t) => {
  const env = await makeEnv(t);
  await mkdir(join(env.base, 'real'));
  await put(env.base, 'real/a.txt', 'inside the linked root');
  await symlink(join(env.base, 'real'), join(env.base, 'link'));
  await put(env.base, 'real/.env', 'SECRET=1');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(env.configFile, JSON.stringify({ roots: [join(env.base, 'link')], security: { audit_logging: false } }));
  const { scan } = await import('../lib/scanner.js');
  await scan(undefined, {});
  assert.deepEqual(env.db.openDb().prepare('SELECT path FROM files').all().map((r) => r.path), [join(env.base, 'link', 'a.txt')]);
});

test('asking for a subdirectory keeps the configured root as the policy boundary', async (t) => {
  const env = await makeEnv(t);
  await put(env.root, '.gitignore', 'out\n*.log\n');
  await put(env.root, '.ssh/config', 'Host x');
  await put(env.root, 'out/a.txt', 'ignored by the root .gitignore');
  await put(env.root, 'sub/keep.txt', 'fine');
  await put(env.root, 'sub/app.log', 'ignored by the root .gitignore');
  await put(env.root, '.config/gcloud/application_default_credentials.json', '{}');
  await put(env.root, '.config/other/ok.txt', 'fine');
  const { scan } = await import('../lib/scanner.js');
  for (const bad of ['.ssh', 'out', '.config/gcloud']) {
    await assert.rejects(scan([join(env.root, ...bad.split('/'))], {}), { code: 'SCOPE_INVALID' }, bad);
  }
  await scan([join(env.root, 'sub')], {});
  assert.deepEqual(indexedPaths(env.db, env.root), ['sub/keep.txt'], 'the root .gitignore still applies below a subdirectory request');
  await scan(undefined, {});
  const paths = indexedPaths(env.db, env.root);
  assert.ok(paths.includes('.config/other/ok.txt'));
  assert.ok(!paths.some((p) => p.includes('gcloud')), 'a full scan skips .config/gcloud too');
  assert.ok(!paths.some((p) => p.startsWith('.ssh') || p.startsWith('out/') || p.endsWith('.log')));
});
