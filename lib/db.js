import { mkdirSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadNxEnv } from './env.js';

const require = createRequire(import.meta.url);

export function dbPath() {
  return process.env.NX_SEARCH_DB || join(homedir(), '.local', 'share', 'nx-search', 'index.db');
}

const live = new Map();

export function openDb({ durable = true } = {}) {
  const path = dbPath();
  const cached = live.get(path);
  if (cached) return cached;
  
  // Ensure directory exists with proper permissions
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  
  // Set directory permissions (Unix only)
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch (e) {
      // Ignore permission errors
    }
  }

  const db = openRaw(path);
  db.pragma('journal_mode = WAL');
  db.pragma(durable ? 'synchronous = NORMAL' : 'synchronous = OFF');
  db.pragma('cache_size = -131072');
  db.pragma('mmap_size = 268435456');
  migrate(db);
  
  const origClose = typeof db.close === 'function' ? db.close.bind(db) : () => {};
  let closed = false;
  db.close = () => {
    if (closed) return;
    closed = true;
    live.delete(path);
    origClose();
  };
  live.set(path, db);
  return db;
}

export function closeDb(path = dbPath()) {
  const db = live.get(path);
  if (db) db.close();
}

function openRaw(path) {
  // Check if encryption is enabled in config
  let config = { security: { encryption: false } };
  try {
    const CONFIG_PATH = process.env.NX_SEARCH_CONFIG || join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
    const cfgRaw = require(CONFIG_PATH);
    config = { ...config, ...cfgRaw, security: { ...config.security, ...cfgRaw.security } };
    
    if (config.security.encryption) {
      throw new Error('Index encryption is required but not supported in this version. Set NX_SEARCH_ENCRYPTION_KEY environment variable with a strong key to enable encryption.');
    }
  } catch (e) {
    // No config or config error - use defaults
  }
  
  try {
    const { DatabaseSync } = require('node:sqlite');
    return wrapNodeSqlite(new DatabaseSync(path));
  } catch (sqliteErr) {
    try {
      const Database = require('better-sqlite3');
      return new Database(path);
    } catch (nativeErr) {
      throw new Error(
        `nx-search needs Node.js 22.13+ (built-in sqlite) or a rebuilt better-sqlite3. ${nativeErr.message}`,
      );
    }
  }
}

function wrapNodeSqlite(db) {
  if (typeof db.pragma !== 'function') {
    db.pragma = (stmt) => {
      db.exec(`PRAGMA ${stmt}`);
    };
  }
  if (typeof db.transaction !== 'function') {
    db.transaction = (fn) => (...args) => {
      db.exec('BEGIN');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already aborted
        }
        throw err;
      }
    };
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      volume TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      text_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext);
    CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(
      path UNINDEXED,
      body,
      tokenize = 'porter unicode61'
    );
  `);
}

export const upsertFile = (db) =>
  db.prepare(`
    INSERT INTO files (path, volume, name, ext, size, mtime, indexed_at, text_status)
    VALUES (@path, @volume, @name, @ext, @size, @mtime, @indexedAt, @textStatus)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      indexed_at = excluded.indexed_at,
      text_status = excluded.text_status
    RETURNING id
  `);

export const replaceBody = (db) =>
  db.prepare(`DELETE FROM content WHERE rowid = ?`);

export const insertBody = (db) =>
  db.prepare(`INSERT INTO content (rowid, path, body) VALUES (?, ?, ?)`);

export const findUnchanged = (db) =>
  db.prepare(`SELECT path FROM files WHERE path = ? AND size = ? AND mtime = ? AND text_status != 'pending'`);

export const deleteFile = (db) => {
  const delContent = db.prepare(`DELETE FROM content WHERE rowid = (SELECT id FROM files WHERE path = ?)`);
  const delFile = db.prepare(`DELETE FROM files WHERE path = ?`);
  return { run(path) { delContent.run(path); delFile.run(path); } };
};

// New: purge-unsafe command to remove already-indexed sensitive data
export function purgeUnsafe(db) {
  // Load config to get secret patterns
  let config = { secret_exclude_patterns: [] };
  try {
    const CONFIG_PATH = process.env.NX_SEARCH_CONFIG || join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
    const cfgRaw = require(CONFIG_PATH);
    config = { ...config, ...cfgRaw, security: { ...config.security, ...cfgRaw.security } };
  } catch (e) {
    // No config
  }
  
  const secretPatterns = config.secret_exclude_patterns || [];
  let total = 0;
  let deleted = 0;
  
  if (secretPatterns.length > 0) {
    for (const pattern of secretPatterns) {
      try {
        // Convert glob pattern to SQL LIKE pattern
        const sqlPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '%').replace(/\?/g, '_');
        const cleanPattern = sqlPattern.replace(/^\./, '').replace(/\.$/, '');
        
        // First delete content rows
        const delContent = db.prepare(`
          DELETE FROM content 
          WHERE rowid IN (
            SELECT id FROM files WHERE path LIKE ?
          )
        `);
        const contentResult = delContent.run(`%${cleanPattern}%`);
        
        // Then delete file entries
        const delFile = db.prepare(`DELETE FROM files WHERE path LIKE ?`);
        const fileResult = delFile.run(`%${cleanPattern}%`);
        
        deleted += (contentResult.changes || 0) + (fileResult.changes || 0);
      } catch (e) {
        console.error(`Error purging pattern ${pattern}:`, e.message);
      }
    }
  }
  
  total = db.prepare(`SELECT COUNT(*) as c FROM files`).get().c;
  
  return { total, deleted };
}