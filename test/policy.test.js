import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getPolicy, loadConfig, redact } from '../lib/policy.js';
import { makeEnv, put } from './helpers.js';

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('a missing config is fine for reading, but scanning needs roots', async (t) => {
  await makeEnv(t);
  process.env.NX_SEARCH_CONFIG = join(process.env.NX_SEARCH_CONFIG, '..', 'absent.json');
  assert.equal(loadConfig().security.search_result_cap, 50);
  assert.equal(code(() => loadConfig({ requireRoots: true })), 'SCOPE_UNCONFIGURED');
});

test('an unreadable or invalid config is an error, never a silent default', async (t) => {
  const env = await makeEnv(t);
  await writeFile(env.configFile, '{ not json');
  assert.equal(code(() => loadConfig()), 'CONFIG_INVALID');
  await writeFile(env.configFile, JSON.stringify({ roots: [env.root], security: { redaction_patterns: ['('] } }));
  assert.equal(code(() => loadConfig()), 'CONFIG_INVALID');
  await writeFile(env.configFile, JSON.stringify({ roots: 'C:\\x' }));
  assert.equal(code(() => loadConfig()), 'CONFIG_INVALID');
  await writeFile(env.configFile, JSON.stringify({ roots: [], security: { rate_limit_qpm: 0 } }));
  assert.equal(code(() => loadConfig()), 'CONFIG_INVALID');
});

test('empty roots refuse to scan', async (t) => {
  await makeEnv(t, { roots: [] });
  assert.equal(code(() => getPolicy({ requireRoots: true })), 'SCOPE_UNCONFIGURED');
});

test('secret file names match whatever the case, and the config can only add patterns', async (t) => {
  await makeEnv(t, { secretPatterns: ['*.vault'] });
  const p = getPolicy();
  for (const name of ['.env', '.ENV', 'prod.env', 'Credentials.json', 'ID_RSA', 'id_ed25519.pub', 'app.PEM', 'my.KEY',
    'secret-santa.txt', '.npmrc', 'x.kdbx', 'team.VAULT']) {
    assert.equal(p.isSecretFileName(name), true, name);
  }
  for (const name of ['notes.txt', 'README.md', 'envelope.txt', 'environment.md', 'keynote.txt']) {
    assert.equal(p.isSecretFileName(name), false, name);
  }
});

test('secret and system directories are not descended into', async (t) => {
  const env = await makeEnv(t);
  const p = getPolicy();
  for (const name of ['secrets', 'Passwords', 'CREDENTIALS', '.ssh', '.aws', '.gnupg', 'node_modules', '.git']) {
    assert.equal(p.shouldDescend(join(env.root, name), name, env.root), false, name);
  }
  assert.equal(p.shouldDescend(join(env.root, 'docs'), 'docs', env.root), true);
});

test('root checks understand Windows path forms and case', async (t) => {
  await makeEnv(t, { roots: ['C:\\Users\\jon\\Documents'] });
  const p = getPolicy({ platform: 'win32' });
  for (const bad of ['C:/Windows/System32', 'c:\\windows\\system32', 'C:\\WINDOWS', 'D:\\Program Files (x86)\\x', 'C:\\ProgramData']) {
    assert.equal(code(() => p.resolveRoots([bad])), 'SCOPE_INVALID', bad);
  }
  assert.equal(code(() => p.resolveRoots(['C:\\Users\\other'])), 'SCOPE_INVALID');
  assert.equal(code(() => p.resolveRoots(['C:\\Users\\jon\\Documents\\..\\..\\other'])), 'SCOPE_INVALID');
  assert.deepEqual(p.resolveRoots(['c:/users/JON/documents/sub']), ['c:\\users\\JON\\documents\\sub']);
  assert.deepEqual(p.resolveRoots(), ['C:\\Users\\jon\\Documents']);
});

test('a system location cannot be configured as a root', async (t) => {
  await makeEnv(t, { roots: ['C:\\Windows\\System32'] });
  assert.equal(code(() => getPolicy({ platform: 'win32' }).resolveRoots()), 'SCOPE_INVALID');
});

test('posix system locations and roots outside the configuration are refused', { skip: process.platform === 'win32' }, async (t) => {
  const env = await makeEnv(t);
  const p = getPolicy({ platform: 'linux' });
  assert.equal(code(() => p.resolveRoots(['/etc/ssl'])), 'SCOPE_INVALID');
  assert.equal(code(() => p.resolveRoots(['/proc'])), 'SCOPE_INVALID');
  assert.equal(code(() => p.resolveRoots([join(env.base, 'elsewhere')])), 'SCOPE_INVALID');
  assert.deepEqual(p.resolveRoots([join(env.root, 'sub')]), [join(env.root, 'sub')]);
});

test('a symlink inside a root cannot lead the scan outside it', { skip: process.platform === 'win32' }, async (t) => {
  const env = await makeEnv(t);
  await mkdir(join(env.base, 'outside'));
  await symlink(join(env.base, 'outside'), join(env.root, 'link'));
  assert.equal(code(() => getPolicy().resolveRoots([join(env.root, 'link')])), 'SCOPE_INVALID');
  await symlink('/etc', join(env.root, 'etclink'));
  assert.equal(code(() => getPolicy().resolveRoots([join(env.root, 'etclink')])), 'SCOPE_INVALID');
});

test('.gitignore: globs, negation, anchoring and directory-only rules; no substring matches', async (t) => {
  const env = await makeEnv(t);
  await put(env.root, '.gitignore', '*.log\n!keep.log\nout\n/top-only\ndocs/*.tmp\ncache/\n**/gen/\n');
  await put(env.root, 'sub/.gitignore', '!debug.log\n*.log\n');
  const p = getPolicy();
  const file = (rel) => p.fileViolation(join(env.root, ...rel.split('/')), { deep: true });
  const dir = (rel) => p.shouldDescend(join(env.root, ...rel.split('/')), rel.split('/').pop(), env.root);
  assert.equal(file('app.log'), 'gitignored');
  assert.equal(file('x/y/app.log'), 'gitignored');
  assert.equal(file('keep.log'), null);
  assert.equal(file('notes.txt'), null);
  assert.equal(file('docs/a.tmp'), 'gitignored');
  assert.equal(file('other/a.tmp'), null);
  assert.equal(file('out/a.txt'), 'gitignored');
  assert.equal(file('rebuild-out/a.txt'), null);
  assert.equal(file('top-only'), 'gitignored');
  assert.equal(file('x/top-only'), null);
  assert.equal(file('a/b/gen/z.txt'), 'gitignored');
  assert.equal(file('cache'), null);
  assert.equal(dir('cache'), false);
  assert.equal(dir('out'), false);
  assert.equal(dir('rebuild-notes'), true);
  assert.equal(file('sub/debug.log'), 'gitignored');
});

test('paths below a denied directory or outside the roots are rejected for watch and purge', async (t) => {
  const env = await makeEnv(t);
  const p = getPolicy();
  const v = (rel) => p.fileViolation(join(env.root, ...rel.split('/')), { deep: true });
  assert.equal(v('secrets/db.txt'), 'denied-directory');
  assert.equal(v('a/.ssh/config'), 'denied-directory');
  assert.equal(v('.config/gcloud/creds.json'), 'denied-directory');
  assert.equal(v('x/.config/gcloud/app.txt'), 'denied-directory');
  assert.equal(v('a/prod.env'), 'secret-file');
  assert.equal(v('a/readme.md'), null);
  assert.equal(p.fileViolation(join(env.base, 'elsewhere', 'a.txt'), { deep: true }), 'outside-roots');
});

test('redaction removes the whole secret, keeps the surrounding text, and is idempotent', async (t) => {
  await makeEnv(t);
  const text = [
    'openai sk-ABCDEFGHIJKLMNOP1234567890 end',
    'gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 end',
    'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop end',
    'aws AKIAABCDEFGHIJKLMNOP end',
    'slack xoxb-1234567890-abcdefghij end',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv end',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
    '-----END RSA PRIVATE KEY-----',
    'password = hunter2',
    'API_KEY="abc123def456"',
    'task-list and desk-lamp and risk-assessment',
  ].join('\n');
  const out = redact(text);
  for (const leaked of ['ABCDEFGHIJKLMNOP1234567890', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', '11ABCDEFG0123456789', 'AKIAABCDEFGHIJKLMNOP',
    'abcdefghij end', 'eyJzdWIi', 'MIIEowIB', 'hunter2', 'abc123def456']) {
    assert.ok(!out.includes(leaked), `leaked: ${leaked}`);
  }
  assert.ok(out.includes('password = [REDACTED]') && out.includes('API_KEY="[REDACTED]"'), 'key names stay, values go');
  assert.ok(out.includes('task-list and desk-lamp and risk-assessment'), 'ordinary words are untouched');
  assert.equal(redact(out), out);
});

test('an unterminated private-key block is redacted to the end of the text', async (t) => {
  await makeEnv(t);
  assert.equal(redact('before\n-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkq'), 'before\n[REDACTED]');
});

test('configured redaction patterns are applied on top of the built-in ones', async (t) => {
  await makeEnv(t, { security: { redaction_patterns: ['ACME-[0-9]{4}'] } });
  assert.equal(redact('id ACME-1234 and sk-ABCDEFGHIJKLMNOP1234567890'), 'id [REDACTED] and [REDACTED]');
});

test('on macOS a sibling that differs only by case is not inside the root', async (t) => {
  await makeEnv(t, { roots: ['/Volumes/Data/Root'] });
  const p = getPolicy({ platform: 'darwin' });
  assert.equal(code(() => p.resolveRoots(['/Volumes/Data/root'])), 'SCOPE_INVALID');
  assert.deepEqual(p.resolveRoots(['/Volumes/Data/Root/sub']), ['/Volumes/Data/Root/sub']);
});

test('multi-segment denials such as .config/gcloud apply while walking, not only in watch and purge', async (t) => {
  const env = await makeEnv(t);
  const p = getPolicy();
  assert.equal(p.shouldDescend(join(env.root, '.config', 'gcloud'), 'gcloud', env.root), false);
  assert.equal(p.shouldDescend(join(env.root, 'x', '.config', 'gcloud'), 'gcloud', env.root), false);
  assert.equal(p.shouldDescend(join(env.root, '.config'), '.config', env.root), true);
  assert.equal(p.shouldDescend(join(env.root, 'x', '.config', 'other'), 'other', env.root), true);
});

test('redaction covers JSON, YAML, env and INI forms of a secret, quoted or not', async (t) => {
  await makeEnv(t);
  const cases = {
    '{"password":"hunter2"}': '{"password":"[REDACTED]"}',
    '{"api_key": "abc123", "name": "x"}': '{"api_key": "[REDACTED]", "name": "x"}',
    "{'token': 'abc123'}": "{'token': '[REDACTED]'}",
    'password: hunter2': 'password: [REDACTED]',
    'DB_PASSWORD=hunter2': 'DB_PASSWORD=[REDACTED]',
    'AWS_SECRET_ACCESS_KEY = abc/def+123': 'AWS_SECRET_ACCESS_KEY = [REDACTED]',
    'GITHUB_TOKEN="abc123"': 'GITHUB_TOKEN="[REDACTED]"',
    '"password": "has spaces in it"': '"password": "[REDACTED]"',
    '{"password":"x\\"hunter2"}': '{"password":"[REDACTED]"}',
    "password: 'it\\'s secret'": "password: '[REDACTED]'",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(redact(input), expected, input);
    assert.equal(redact(expected), expected, `idempotent: ${expected}`);
  }
  assert.equal(redact('tokens are explained in the passwords chapter'), 'tokens are explained in the passwords chapter');
});

test('a root that is a link to / cannot be used to reach system directories', { skip: process.platform === 'win32' }, async (t) => {
  const env = await makeEnv(t);
  const alias = join(env.base, 'all');
  await symlink('/', alias);
  await writeFile(env.configFile, JSON.stringify({ roots: [alias], security: { audit_logging: false } }));
  const p = getPolicy();
  for (const name of ['etc', 'proc', 'var', 'root']) {
    assert.equal(p.shouldDescend(join(alias, name), name, alias), false, name);
  }
  assert.equal(p.shouldDescend(join(alias, 'home'), 'home', alias), true);
});

test('the audit log is recognised under a linked root too', { skip: process.platform === 'win32' }, async (t) => {
  const env = await makeEnv(t);
  await mkdir(join(env.base, 'real'));
  await symlink(join(env.base, 'real'), join(env.base, 'link'));
  process.env.NX_AUDIT_LOG = join(env.base, 'real', 'audit.log');
  await writeFile(env.configFile, JSON.stringify({ roots: [join(env.base, 'link')], security: { audit_logging: false } }));
  await put(join(env.base, 'link'), 'audit.log', '{"query":"private"}');
  await put(join(env.base, 'link'), 'notes.txt', 'ordinary');
  const p = getPolicy();
  const root = join(env.base, 'link');
  assert.equal(p.fileViolation(join(root, 'audit.log'), { root }), 'internal-file');
  assert.equal(p.fileViolation(join(root, 'notes.txt'), { root }), null);
});
