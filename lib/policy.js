// One policy for everything that reads files into the index or hands index content back out.
//
// scan, watch, purge, search, RAG and the MCP bridge all go through this module, so a control cannot exist
// on one path and be missing on another. Nothing here runs at import time: no process.exit, and a bad config
// is an error the caller sees (ScopeError), never a silent fall back to "no protection".
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { auditLogPath, dbPath } from './paths.js';

export class ScopeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ScopeError';
    this.code = code;
  }
}

// --- built-in rules (config can add to these, never remove them) ------------------------------------------

// Trailing "/" means a directory name. Matching is anchored to the whole name and case-insensitive.
export const BUILTIN_SECRET_GLOBS = [
  '*.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.kdbx', '*.keystore', '*.jks',
  'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*',
  'credentials*.json', '*secret*', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'secrets/', 'passwords/', 'credentials/',
];

// Directory names never descended into.
const DENY_DIR_NAMES = [
  'Windows', 'WinSxS', 'System32', 'SysWOW64', 'Program Files', 'Program Files (x86)', 'ProgramData',
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
  '$RECYCLE.BIN', 'System Volume Information', '.Trash-1000', '.Trash', 'lost+found',
  '.venv', 'venv', '.tox', 'target', 'dist', 'build',
  '.rustup', '.cargo', '.npm', '.nvm', '.pnpm-store', '.gradle', '.m2', '.nuget', '.gem', '.stack', '.opam', '.elan', '.ghcup',
  '.ssh', '.aws', '.gnupg',
];
// Multi-segment locations, matched as a sequence of directory names.
const DENY_DIR_SEQUENCES = [['.config', 'gcloud']];

const POSIX_DENY_ROOTS = ['/proc', '/sys', '/dev', '/run', '/snap', '/var', '/etc', '/root', '/boot'];
// The shared temp directory itself is denied (it holds other users' and services' files), but a private folder you create
// under it is an ordinary root; /var/tmp is already covered by /var.
const POSIX_DENY_EXACT = ['/tmp'];
const WIN_SYSTEM_DIRS = String.raw`(?:windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information)`;
// C:\Windows\..., and the same places reached over UNC administrative shares: \\host\C$\Windows\... and \\host\ADMIN$ (= %SystemRoot%)
const WIN_DENY_ROOT = new RegExp(String.raw`^(?:[a-z]:\\|\\\\[^\\]+\\[a-z]\$\\)${WIN_SYSTEM_DIRS}(?:\\|$)|^\\\\[^\\]+\\admin\$(?:\\|$)|^\\\\[?.]\\volume\{[^}]+\}\\${WIN_SYSTEM_DIRS}(?:\\|$)`);

// password / token / api key in env, YAML, INI, TOML and JSON ("password": "x") form; the key name (and its quotes) stay.
// Two variants share everything but the unquoted value: inside a flow collection ({a: 1, password: x, b: 2}) an unquoted value
// stops at , } ] so siblings survive; anywhere else it runs to the end of the line (passwords contain spaces and commas).
const SECRET_KEYS = String.raw`api[_-]?key|apikey|passwd|password|secret|auth[_-]?token|access[_-]?token|access[_-]?key|token`;
const QUOTED_VALUE = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.|'')*'`;

// A secret whose value is a whole collection: "password": ["a", "b"], token: {x: [1, 2]}. The balanced collection (quotes and
// escapes respected) is replaced as one value, so no inner comma or bracket can end it early and leave part of it behind.
const COLLECTION_KEY = new RegExp(String.raw`(["']?)\b([A-Za-z0-9_.-]*?(?:${SECRET_KEYS}))\1([ \t]*[:=][ \t]*)(?=[\[{])`, 'gi');

function matchingClose(text, open) {
  const stack = [];
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') stack.push(c);
    else if (c === ']' || c === '}') {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1; // unbalanced: the other rules deal with the line
}

function redactCollections(text) {
  let out = '';
  let last = 0;
  COLLECTION_KEY.lastIndex = 0;
  for (let m = COLLECTION_KEY.exec(text); m; m = COLLECTION_KEY.exec(text)) {
    const end = matchingClose(text, m.index + m[0].length);
    if (end === -1) continue;
    out += `${text.slice(last, m.index)}${m[1]}${m[2]}${m[1]}${m[3]}[REDACTED]`;
    last = end + 1;
    COLLECTION_KEY.lastIndex = last;
  }
  return out + text.slice(last);
}

function keyValueRule(lookbehind, unquoted) {
  return {
    re: new RegExp(String.raw`${lookbehind}(["']?)\b([A-Za-z0-9_.-]*?(?:${SECRET_KEYS}))\1([ \t]*[:=][ \t]*)(?![|>][-+0-9]*[ \t]*\r?\n)(${QUOTED_VALUE}|${unquoted})`, 'gi'),
    replace: (_m, q, key, sep, value) => {
      // TOML triple-quoted strings (multi-line allowed) keep their triple quotes; otherwise a single quote character, or none
      const triple = /^("""|''')/.exec(value)?.[1];
      const quote = triple ?? (value[0] === '"' || value[0] === "'" ? value[0] : '');
      return `${q}${key}${q}${sep}${quote}[REDACTED]${quote}`;
    },
  };
}

// Whole secret values are replaced; for key=value the name is kept and only the value goes.
export const BUILTIN_REDACTIONS = [
  { name: 'private-key-block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'yaml-block-scalar', fn: redactBlockScalars },
  {
    // <password>hunter2</password>, <apiKey attr="x"><![CDATA[...]]></apiKey>: the element name carries the meaning
    name: 'xml-element',
    re: new RegExp(String.raw`(<([A-Za-z0-9_.:-]*?(?:${SECRET_KEYS}))(?:\s[^>]*)?>)(?:<!\[CDATA\[[\s\S]*?\]\]>|[^<]*)(</\2\s*>)`, 'gi'),
    replace: (_m, open, _name, close) => `${open}[REDACTED]${close}`,
  },
  { name: 'secret-collection', fn: redactCollections },
  { name: 'key-value-flow', ...keyValueRule(String.raw`(?<=[{\[,][ \t]*)`, String.raw`\[REDACTED\]|[^\s,}\]][^,}\]\r\n]*`) },
  { name: 'key-value', ...keyValueRule(String.raw`(?<![{\[,][ \t]*)`, String.raw`[^\s][^\r\n]*`) },
];

// YAML block scalars: `password: |-` (or `>`, `|2-`, list items `- password: |`) followed by lines indented deeper than the key.
// The key's column counts any `- ` markers before it, so sibling keys of the same mapping are never swallowed. Line endings
// (LF or CRLF) are kept. Done line by line because "deeper than the key" is not something a regular expression can express.
const BLOCK_HEADER = /^([ \t]*)((?:-[ \t]+)*)(["']?)([A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|passwd|password|secret|auth[_-]?token|access[_-]?token|access[_-]?key|token))\3[ \t]*:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/i;

// A plain (unquoted) value on the key's own line, e.g. `password: correct horse`. YAML lets it continue on lines indented
// deeper than the key (`  battery staple`), and nothing else can be indented under a scalar, so those lines belong to it.
const PLAIN_HEADER = /^([ \t]*)((?:-[ \t]+)*)(["']?)([A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|passwd|password|secret|auth[_-]?token|access[_-]?token|access[_-]?key|token))\3[ \t]*[:=][ \t]*(?![|>#"'\s])[^\r\n]*$/i;

function redactBlockScalars(text) {
  const parts = text.split(/(\r?\n)/); // line, eol, line, eol, ..., line
  const out = [];
  for (let i = 0; i < parts.length; ) {
    out.push(parts[i], parts[i + 1] ?? '');
    const header = BLOCK_HEADER.exec(parts[i]);
    const plain = header ? null : PLAIN_HEADER.exec(parts[i]);
    i += 2;
    if (!header && !plain) continue;
    const keyColumn = (header ?? plain)[1].length + (header ?? plain)[2].length;
    let indent = null;
    let last = -1;
    for (let j = i; j < parts.length; j += 2) {
      const line = parts[j];
      if (line.trim() === '') continue; // blank lines belong to the block when more of it follows
      const lead = line.length - line.trimStart().length;
      if (lead <= keyColumn) break;
      indent ??= line.slice(0, lead);
      last = j;
    }
    if (last !== -1 && plain) {
      i = last + 2; // the continuation lines are part of the (already redacted) value: drop them
    } else if (last !== -1) {
      out.push(`${indent}[REDACTED]`, parts[last + 1] ?? '');
      i = last + 2;
    }
  }
  return out.join('');
}

// --- configuration ----------------------------------------------------------------------------------------

const DEFAULT_SECURITY = {
  encryption: false,
  search_result_cap: 50,
  rate_limit_qpm: 60,
  audit_logging: true,
  audit_log_queries: false,
  redaction_patterns: [],
};

export function configPath() {
  return process.env.NX_SEARCH_CONFIG || path.join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
}

function fail(code, message) {
  throw new ScopeError(code, message);
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) fail('CONFIG_INVALID', `${label} must be a list of strings`);
  return value;
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail('CONFIG_INVALID', `${label} must be true or false (a quoted "true" is not a boolean)`);
  return value;
}

// An empty string resolves to the process working directory, which would quietly turn "no path" into "wherever I was started".
function nonBlank(list, label) {
  if (list.some((v) => v.trim() === '')) fail('CONFIG_INVALID', `${label} must not contain empty entries`);
  return list;
}

function positiveInt(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) fail('CONFIG_INVALID', `${label} must be a positive integer`);
  return value;
}

function parseConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('CONFIG_INVALID', 'the config must be a JSON object');
  const sec = raw.security ?? {};
  if (typeof sec !== 'object' || Array.isArray(sec)) fail('CONFIG_INVALID', 'security must be an object');
  const redactionPatterns = stringList(sec.redaction_patterns, 'security.redaction_patterns').map((src) => {
    try {
      return new RegExp(src, 'gi');
    } catch (err) {
      return fail('CONFIG_INVALID', `security.redaction_patterns: "${src}" is not a valid regular expression (${err.message})`);
    }
  });
  return {
    roots: nonBlank(stringList(raw.roots, 'roots'), 'roots'),
    secretGlobs: [...BUILTIN_SECRET_GLOBS, ...stringList(raw.secret_exclude_patterns, 'secret_exclude_patterns')],
    extraSkipDirs: nonBlank(stringList(raw.extra_skip_dirs, 'extra_skip_dirs'), 'extra_skip_dirs'),
    security: {
      encryption: boolean(sec.encryption, 'security.encryption', false),
      search_result_cap: positiveInt(sec.search_result_cap, 'security.search_result_cap', DEFAULT_SECURITY.search_result_cap),
      rate_limit_qpm: positiveInt(sec.rate_limit_qpm, 'security.rate_limit_qpm', DEFAULT_SECURITY.rate_limit_qpm),
      audit_logging: boolean(sec.audit_logging, 'security.audit_logging', true),
      audit_log_queries: boolean(sec.audit_log_queries, 'security.audit_log_queries', false),
    },
    redactionRegexes: redactionPatterns,
    exists: true,
  };
}

const configCache = new Map();

/**
 * Load the config. A missing file is fine unless the caller needs roots (then SCOPE_UNCONFIGURED); an unreadable or
 * invalid file is always an error, never a silent default.
 */
export function loadConfig({ requireRoots = false } = {}) {
  const file = configPath();
  let stat;
  try {
    stat = statSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') fail('CONFIG_INVALID', `cannot read ${file}: ${err.message}`);
    if (requireRoots) fail('SCOPE_UNCONFIGURED', `no config at ${file}; create it with the roots nx-search may index`);
    const dkey = `default:${file}`;
    if (!configCache.has(dkey)) configCache.set(dkey, { ...parseConfig({}), exists: false, file, version: dkey });
    return configCache.get(dkey);
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  let cfg = configCache.get(key);
  if (!cfg) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      fail('CONFIG_INVALID', `${file} is not valid JSON (${err.message})`);
    }
    cfg = { ...parseConfig(raw), file, version: key };
    configCache.clear();
    configCache.set(key, cfg);
  }
  if (requireRoots && cfg.roots.length === 0) fail('SCOPE_UNCONFIGURED', `no roots configured in ${file}`);
  return cfg;
}

// --- paths ------------------------------------------------------------------------------------------------

function makeOps(platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // Only Windows is assumed case-insensitive. macOS volumes can be either, and realpath returns the true case for paths
  // that exist, so folding there could let a sibling that differs only by case pass the allowlist.
  const fold = platform === 'win32';
  // Win32 namespace prefixes: \\?\UNC\server\share -> \\server\share (a plain strip would leave a RELATIVE path),
  // \\?\C:\dir and \\.\C:\dir -> C:\dir
  const strip = (x) => (platform === 'win32' ? x.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '') : x);
  const abs = (x) => strip(p.resolve(expandEnv(x, platform)));
  return {
    platform,
    p,
    fold,
    abs,
    key: (x) => (fold ? abs(x).toLowerCase() : abs(x)),
    real(x) {
      const a = abs(x);
      if (platform !== process.platform) return a;
      try {
        return strip(realpathSync.native(a));
      } catch {
        return a;
      }
    },
  };
}

function expandEnv(value, platform) {
  let out = value;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = homedir() + out.slice(1);
  out = out.replace(/%([A-Za-z0-9_]+)%/g, (m, name) => process.env[name] ?? m);
  if (platform !== 'win32') out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] ?? m);
  return out;
}

function globToRegex(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

// --- .gitignore -------------------------------------------------------------------------------------------

function ruleFromLine(rawLine, fold) {
  let line = rawLine.replace(/\r$/, '');
  if (!line.trim() || line.startsWith('#')) return null;
  line = line.replace(/(?<!\\)\s+$/, '');
  let neg = false;
  if (line.startsWith('!')) {
    neg = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return null;
  const anchored = line.includes('/');
  line = line.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '*') {
      if (line[i + 1] === '*') {
        const atStart = i === 0 || line[i - 1] === '/';
        if (atStart && line[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else if (atStart && i + 2 === line.length) {
          re += '.*';
          i += 1;
        } else {
          re += '[^/]*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = line.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        re += `[${line.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < line.length) {
      i += 1;
      re += line[i].replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { neg, dirOnly, regex: new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`, fold ? 'i' : '') };
}

function makeIgnoreCache(ops) {
  const cache = new Map();
  return function rulesFor(dir) {
    const file = ops.p.join(dir, '.gitignore');
    let stat;
    try {
      stat = statSync(file);
    } catch {
      cache.delete(dir);
      return [];
    }
    const hit = cache.get(dir);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.rules;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      /* unreadable .gitignore: treat as empty */
    }
    const rules = text.split('\n').map((l) => ruleFromLine(l, ops.fold)).filter(Boolean);
    cache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
    return rules;
  };
}

// --- the policy -------------------------------------------------------------------------------------------

/**
 * Build the policy for the current config.
 * @param {{requireRoots?: boolean, platform?: string}} opts platform exists so Windows path rules can be tested anywhere.
 */
const policyCache = new WeakMap();

export function getPolicy({ requireRoots = false, platform = process.platform } = {}) {
  const config = loadConfig({ requireRoots });
  const byPlatform = policyCache.get(config) ?? new Map();
  policyCache.set(config, byPlatform);
  if (!byPlatform.has(platform)) byPlatform.set(platform, buildPolicy(config, platform));
  return byPlatform.get(platform);
}

function buildPolicy(config, platform) {
  const ops = makeOps(platform);
  const secretFileRes = config.secretGlobs.filter((g) => !g.endsWith('/')).map(globToRegex);
  const secretDirRes = config.secretGlobs.filter((g) => g.endsWith('/')).map((g) => globToRegex(g.slice(0, -1)));
  const denyNames = new Set([...DENY_DIR_NAMES, ...config.extraSkipDirs.filter((d) => !/[\\/]/.test(d))].map((n) => n.toLowerCase()));
  const denySeqs = DENY_DIR_SEQUENCES.map((s) => s.map((n) => n.toLowerCase()));
  const rulesFor = makeIgnoreCache(ops);

  const isUnder = (child, parent) => {
    const c = ops.key(child);
    const par = ops.key(parent);
    return c === par || c.startsWith(par.endsWith(ops.p.sep) ? par : par + ops.p.sep);
  };

  // Compared by real path (a linked root keeps its alias in `target`), but only when the file name matches, so scans
  // do not pay a realpath per file.
  const realRoots = new Map();
  const realRootOf = (root) => {
    if (!realRoots.has(root)) realRoots.set(root, ops.real(root));
    return realRoots.get(root);
  };

  function isInternalFile(target) {
    const name = ops.p.basename(target).toLowerCase();
    const log = auditLogPath();
    if (name === ops.p.basename(log).toLowerCase() && ops.key(ops.real(target)) === ops.key(ops.real(log))) return true;
    // the index database and its SQLite sidecars
    const db = dbPath();
    const dbName = ops.p.basename(db).toLowerCase();
    if (![dbName, `${dbName}-wal`, `${dbName}-shm`, `${dbName}-journal`].includes(name)) return false;
    const real = ops.key(ops.real(target));
    return [db, `${db}-wal`, `${db}-shm`, `${db}-journal`].some((f) => ops.key(ops.real(f)) === real);
  }

  function isSystemPath(p) {
    // ops.key already lower-cases on Windows only; POSIX paths are case-sensitive (/VAR/project is not under /var)
    const k = ops.key(p);
    if (platform === 'win32') return WIN_DENY_ROOT.test(k);
    return POSIX_DENY_EXACT.includes(k) || POSIX_DENY_ROOTS.some((d) => k === d || k.startsWith(`${d}/`));
  }

  // an absolute skip path is compared both as written and by its real location (a link or alternate spelling of the same tree)
  const extraDenyPaths = [...new Set(config.extraSkipDirs.filter((d) => /[\\/]/.test(d)).flatMap((d) => [ops.abs(d), ops.real(d)]))];

  function resolveRoots(requested) {
    const allowed = config.roots.map((r) => ops.real(r));
    const bad = allowed.find((r) => isSystemPath(r));
    if (bad) fail('SCOPE_INVALID', `configured root is a system location: ${bad}`);
    // A root that IS a denied directory (.ssh, .aws, secrets, .config/gcloud ...) has no denied ancestor below it, so the
    // walk would never notice; refuse it here, for configured and requested roots alike.
    const sensitive = [...allowed, ...(requested ?? []).map((r) => ops.real(r))].find((r) => nameDenied(ops.p.basename(r)) || underSensitiveDirectory(r));
    if (sensitive) fail('SCOPE_INVALID', `root is, or is inside, a denied directory: ${sensitive}`);
    if (allowed.length === 0) fail('SCOPE_UNCONFIGURED', 'no roots configured; refusing to index');
    // Checked on the real path (symlinks, junctions and 8.3 short names resolved) but returned as given, so the
    // paths stored in the index keep the form the user typed.
    if (requested !== undefined && requested.length === 0) fail('SCOPE_INVALID', 'no root was given; pass at least one path, or omit the argument to use the configured roots');
    const given = requested === undefined ? config.roots : requested;
    for (const r of given) {
      const real = ops.real(r);
      if (isSystemPath(real) || extraDenyPaths.some((d) => isUnder(real, d))) fail('SCOPE_INVALID', `root is denied: ${real}`);
      if (!allowed.some((a) => isUnder(real, a))) fail('SCOPE_INVALID', `root is outside the configured roots: ${real}`);
    }
    return [...new Map(given.map((r) => [ops.key(r), ops.abs(r)])).values()];
  }

  const allowedRoots = () => config.roots.map((r) => ops.real(r));

  /**
   * Where to start walking and which configured root is the policy boundary for each requested root. Asking for a
   * subdirectory must not shrink the boundary: .gitignore files and denied directories between the configured root and
   * the subdirectory still apply, so a request for <root>/.ssh or a gitignored folder is refused.
   */
  function scanTargets(requested) {
    resolveRoots(requested); // validates every root first
    if (requested !== undefined && requested.length === 0) fail('SCOPE_INVALID', 'no root was given; pass at least one path, or omit the argument to use the configured roots');
    const given = requested === undefined ? config.roots : requested;
    const displayRoots = config.roots.map((r) => ops.abs(r));
    const targets = new Map();
    for (const r of given) {
      let start = ops.abs(r);
      let root = displayRoots.find((d) => isUnder(start, d));
      if (!root) {
        // reached through a link: fall back to real paths on both sides
        start = ops.real(r);
        root = allowedRoots().find((a) => isUnder(start, a));
      }
      const rel = ops.p.relative(root, start).split(ops.p.sep).filter(Boolean);
      if (rel.length) {
        if (rel.some(nameDenied) || sequenceDenied(rel)) fail('SCOPE_INVALID', `scan root is inside a denied directory: ${start}`);
        if (isIgnored(start, true, { deep: true, root })) fail('SCOPE_INVALID', `scan root is excluded by a .gitignore: ${start}`);
      }
      targets.set(ops.key(start), { path: start, root });
    }
    return [...targets.values()];
  }

  function containingRoot(p) {
    const real = ops.real(p);
    return allowedRoots().find((r) => isUnder(real, r)) ?? null;
  }

  function nameDenied(name) {
    const n = name.toLowerCase();
    return denyNames.has(n) || secretDirRes.some((re) => re.test(name));
  }

  // Any ancestor that is a secret/credential directory (.ssh, .aws, .gnupg, secrets/, ...) or contains a denied sequence
  // (.config/gcloud) anywhere in the path. Ordinary noise directories (build, dist, ...) are not a reason to refuse a root.
  const sensitiveNames = new Set(['.ssh', '.aws', '.gnupg', '.git', '.svn', '.hg', ...config.extraSkipDirs.filter((d) => !/[\\/]/.test(d)).map((d) => d.toLowerCase())]);
  function underSensitiveDirectory(p) {
    const segments = ops.abs(p).split(ops.p.sep).filter(Boolean);
    return segments.some((s) => sensitiveNames.has(s.toLowerCase()) || secretDirRes.some((re) => re.test(s))) || sequenceDenied(segments);
  }

  function endsWithDeniedSequence(dirPath) {
    const lower = ops.abs(dirPath).split(ops.p.sep).filter(Boolean).map((s) => s.toLowerCase());
    return denySeqs.some((seq) => seq.length <= lower.length && seq.every((part, j) => lower[lower.length - seq.length + j] === part));
  }

  function sequenceDenied(segments) {
    const lower = segments.map((s) => s.toLowerCase());
    return denySeqs.some((seq) => lower.some((_, i) => seq.every((part, j) => lower[i + j] === part)));
  }

  function isIgnored(fullPath, isDir, { deep = false, root = null } = {}) {
    const top = root ?? containingRoot(fullPath);
    if (!top) return false;
    const target = root ? ops.abs(fullPath) : ops.real(fullPath);
    const relParts = ops.p.relative(top, target).split(ops.p.sep).filter(Boolean);
    const first = deep ? 1 : relParts.length;
    for (let upto = first; upto <= relParts.length; upto += 1) {
      const candidate = ops.p.join(top, ...relParts.slice(0, upto));
      const candIsDir = upto < relParts.length || isDir;
      let ignored = false;
      let dir = top;
      for (let a = 0; a < upto; a += 1) {
        const rules = rulesFor(dir);
        if (rules.length) {
          const rel = ops.p.relative(dir, candidate).split(ops.p.sep).join('/');
          for (const rule of rules) {
            if (rule.dirOnly && !candIsDir) continue;
            if (rule.regex.test(rel)) ignored = !rule.neg;
          }
        }
        dir = ops.p.join(dir, relParts[a]);
      }
      if (ignored) return true;
    }
    return false;
  }

  return {
    config,
    platform,
    resolveRoots,
    scanTargets,
    containingRoot,
    isSystemPath,
    isSecretFileName: (name) => secretFileRes.some((re) => re.test(name)),

    /** Walk decision for a directory found under a root. */
    shouldDescend(fullDir, name, root) {
      if (nameDenied(name) || endsWithDeniedSequence(fullDir) || isSystemPath(fullDir)) return false;
      // A root that is itself a link (/tmp/all -> /) keeps its alias in walked paths, so judge the real location too.
      // Only the root can be an alias: the walk never follows symlinked directories.
      const real = root ? ops.p.join(realRootOf(root), ops.p.relative(root, fullDir)) : ops.real(fullDir);
      if (isSystemPath(real) || endsWithDeniedSequence(real)) return false;
      if (extraDenyPaths.some((d) => isUnder(fullDir, d) || isUnder(real, d))) return false;
      return !isIgnored(fullDir, true, { root });
    },

    /**
     * Why a file must not be indexed, or null if it may be. `deep` also checks every directory on the way down
     * from the root, for callers (watch, purge) that did not walk there themselves.
     */
    fileViolation(fullPath, { deep = false, root = null } = {}) {
      const top = root ?? containingRoot(fullPath);
      if (!top) return 'outside-roots';
      // With a root from the caller's own walk, paths are compared as walked; otherwise as real paths.
      const target = root ? ops.abs(fullPath) : ops.real(fullPath);
      // The audit log can hold query text; it must never become searchable content.
      if (isInternalFile(target)) return 'internal-file';
      const name = ops.p.basename(target);
      if (secretFileRes.some((re) => re.test(name))) return 'secret-file';
      if (deep) {
        const dirs = ops.p.relative(top, ops.p.dirname(target)).split(ops.p.sep).filter(Boolean);
        if (dirs.some(nameDenied) || sequenceDenied(dirs)) return 'denied-directory';
        if (isSystemPath(target) || extraDenyPaths.some((d) => isUnder(target, d))) return 'system-path';
      }
      if (isIgnored(target, false, { deep, root: top })) return 'gitignored';
      return null;
    },

    /** Replace secrets in text that is about to be stored or returned. */
    redact(text) {
      let out = String(text ?? '');
      for (const rule of BUILTIN_REDACTIONS) out = rule.fn ? rule.fn(out) : out.replace(rule.re, rule.replace ?? '[REDACTED]');
      for (const re of config.redactionRegexes) out = out.replace(re, '[REDACTED]');
      return out;
    },
  };
}

/** Redact with the current config; config problems surface instead of disabling redaction. */
export function redact(text) {
  return getPolicy().redact(text);
}
