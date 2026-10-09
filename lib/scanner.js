import { readdir, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { loadNxEnv } from './env.js';
import { join, extname, basename, dirname, sep } from 'node:path';
import { dbPath } from './db.js';
import { extractText } from './extract.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Load configuration
const CONFIG_PATH = process.env.NX_SEARCH_CONFIG || join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
let config = { roots: [], secret_exclude_patterns: [], extra_skip_dirs: [], security: { encryption: false, search_result_cap: 50, rate_limit_qpm: 60, audit_logging: true, gitignore_paths: ['.'], redaction_patterns: [] } };
try {
  const cfgRaw = require(CONFIG_PATH);
  config = { ...config, ...cfgRaw, security: { ...config.security, ...cfgRaw.security } };
} catch (e) {
  console.error('SCOPE_UNCONFIGURED: Failed to load configuration from ' + CONFIG_PATH + ': ' + e.message);
  console.error('Create ' + CONFIG_PATH + ' with allowed roots.');
  process.exit(1);
}

// Validate roots
if (!config.roots || config.roots.length === 0) {
  console.error('SCOPE_UNCONFIGURED: No roots configured in ' + CONFIG_PATH);
  process.exit(1);
}

// Hard-deny system paths - roots should not be system directories
const SYSTEM_DENY_LIST = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  'D:\\Windows', 'D:\\Program Files', 'D:\\Program Files (x86)', 'D:\\ProgramData',
  'G:\\Windows', 'G:\\Program Files', 'G:\\Program Files (x86)', 'G:\\ProgramData',
  'H:\\Windows', 'H:\\Program Files', 'H:\\Program Files (x86)', 'H:\\ProgramData',
  '/proc', '/sys', '/dev', '/tmp', '/run', '/snap',
  '/var', '/etc', '/root', '/boot'
];

for (const root of config.roots) {
  if (SYSTEM_DENY_LIST.some(deny => root === deny || root.startsWith(deny + sep) || root.startsWith(deny + '/'))) {
    console.error('SCOPE_INVALID: Root path is denied: ' + root);
    process.exit(1);
  }
}

// Hard-deny system paths for SKIP_DIRS
const HARD_DENY_DIRS = new Set([
  'Windows', 'WinSxS', 'System32', 'SysWOW64', 'Program Files', 'Program Files (x86)', 'ProgramData',
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
  '$RECYCLE.BIN', '$Recycle.Bin', 'System Volume Information', '.Trash-1000', '.Trash',
  'lost+found', '.venv', 'venv', '.tox', 'target', 'dist', 'build',
  '.rustup', '.cargo', '.npm', '.nvm', '.pnpm-store', '.gradle',
  '.m2', '.nuget', '.gem', '.stack', '.opam', '.elan', '.ghcup',
  '.ssh', '.aws', '.gnupg', '.config/gcloud',
]);

const SKIP_DIRS = new Set([
  ...HARD_DENY_DIRS,
  ...config.secret_exclude_patterns.map(pat => pat.replace('*', '').replace('?', '.')),
  ...config.extra_skip_dirs,
]);

// Compile redaction patterns
const REDACTION_REGEXES = config.security.redaction_patterns.map(pattern => new RegExp(pattern, 'gi'));

// Compile secret exclusion patterns
const SECRET_EXCLUSION_GLOBS = config.secret_exclude_patterns;

function isSecretFile(path) {
  const basename = path.split(sep).pop() || path;
  return SECRET_EXCLUSION_GLOBS.some(glob => {
    const regex = new RegExp(glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'));
    return regex.test(basename);
  });
}

async function isGitIgnored(dir) {
  let current = dir;
  while (current && current !== dirname(current)) {
    const gitignore = join(current, '.gitignore');
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(gitignore, 'utf8');
      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      for (const pattern of lines) {
        try {
          const regex = new RegExp(pattern.replace('\\*', '.*').replace('\\?', '.'));
          if (regex.test(dir)) return true;
        } catch (e) {
          // Invalid regex, skip
        }
      }
    } catch (e) {
      // .gitignore not found, continue up
    }
    current = dirname(current);
  }
  return false;
}

async function scan(roots = config.roots, { rebuild = false, onProgress } = {}) {
  const { openDb, upsertFile, replaceBody, insertBody, findUnchanged } = await import('./db.js');
  const db = openDb({ durable: false });

  if (rebuild) {
    db.exec('DELETE FROM files; DELETE FROM content;');
  }

  let filesSeen = 0;
  let textIndexed = 0;
  let lowDisk = false;
  const startedAt = Date.now();

  const insertStmt = upsertFile(db);
  const delBodyStmt = replaceBody(db);
  const insBodyStmt = insertBody(db);
  const unchangedStmt = findUnchanged(db);

  const queue = roots.map((r) => ({ path: r, depth: 0 }));
  const MAX_DEPTH = 40;
  let batch = [];
  const FLUSH_EVERY = 300;

  function flush() {
    if (!batch.length) return;
    const tx = db.transaction(() => {
      for (const item of batch) {
        const { id } = insertStmt.get(item.row);
        delBodyStmt.run(id);
        if (item.body) insBodyStmt.run(id, item.row.path, item.body);
      }
    });
    tx();
    batch = [];
  }

  while (queue.length) {
    const { path: dir, depth } = queue.pop();
    if (depth > MAX_DEPTH) continue;

    if (await isGitIgnored(dir)) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (dir === '/' && ['/proc', '/sys', '/dev', '/run', '/snap', '/tmp'].includes(full)) continue;
        queue.push({ path: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      if (isSecretFile(full)) {
        continue;
      }

      filesSeen++;
      const st = await stat(full).catch(() => null);
      if (!st) continue;

      const row = {
        path: full,
        volume: volumeOf(full),
        name: entry.name,
        ext: extname(entry.name).toLowerCase(),
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        indexedAt: Date.now(),
        textStatus: 'pending',
      };

      const unchanged = unchangedStmt.get(full, row.size, row.mtime);
      if (unchanged) {
        insertStmt.get({ ...row, textStatus: 'unchanged' });
        if (filesSeen % 2000 === 0 && onProgress) onProgress(filesSeen, textIndexed);
        continue;
      }

      if (filesSeen % 4000 === 0) {
        try {
          const { bavail, bsize } = await statfs(dirname(dbPath()));
          lowDisk = bavail * bsize < 5_000_000_000;
          if (lowDisk && onProgress) onProgress(filesSeen, -1);
        } catch {}
      }

      if (lowDisk) {
        row.textStatus = 'disk_guard';
        batch.push({ row, body: '' });
      } else if (st.size > extract_js_MAX_EXTRACT_FILE()) {
        row.textStatus = 'too_big';
        batch.push({ row, body: '' });
      } else {
        const { status, body } = await extractText(full, row.ext, row.name);
        let redactedBody = body;
        if (status === 'ok' && REDACTION_REGEXES.length > 0) {
          for (const regex of REDACTION_REGEXES) {
            redactedBody = redactedBody.replace(regex, '[REDACTED]');
          }
        }
        row.textStatus = status;
        if (status === 'ok') textIndexed++;
        batch.push({ row, body: redactedBody });
      }

      if (batch.length >= FLUSH_EVERY) flush();
      if (filesSeen % 500 === 0 && onProgress) onProgress(filesSeen, textIndexed);
    }
  }

  flush();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  
  // Audit logging for scan completion
  if (config.security.audit_logging) {
    try {
      const auditLog = join(homedir(), '.local', 'share', 'nx-search', 'audit.log');
      const fs = require('fs');
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        caller: 'scan',
        op: 'scan',
        query: roots.join(','),
        result: {
          filesSeen,
          textIndexed,
          elapsed,
          dbPath: dbPath()
        }
      }) + '\n';
      fs.writeFileSync(auditLog, logEntry, { flag: 'a' });
    } catch (e) {
      // Ignore audit failures
    }
  }
  
  return { filesSeen, textIndexed, elapsed, dbPath: dbPath() };
}

function extract_js_MAX_EXTRACT_FILE() {
  return 50_000_000;
}

function volumeOf(p) {
  if (process.platform === 'win32') {
    const m = String(p).match(/^[A-Za-z]:/);
    return m ? m[0].toUpperCase() : 'unknown';
  }
  if (p.startsWith('/media/jon/')) return dirname(p).split(sep)[3] || basename(dirname(p));
  return p.split(sep)[1] || '/';
}

// Exports
export { scan as default, scan, volumeOf };