import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export function dbPath() {
  return process.env.NX_SEARCH_DB || join(homedir(), '.local', 'share', 'nx-search', 'index.db');
}

const live = new Map();

export function openDb({ durable = true } = {}) {
  const path = dbPath();
  const cached = live.get(path);
  if (cached) return cached;
  mkdirSync(dirname(path), { recursive: true });
  const db = openRaw(path);
  db.pragma('journal_mode = WAL');
  db.pragma(durable ? 'synchronous = NORMAL' : 'synchronous = OFF');
  db.pragma('cache_size = -131072');
  db.pragma('mmap_size = 268435456');
  migrate(db);
  const origClose = typeof db.close === 'function' ? db.close.bind(db) : () => {};
  db.close = () => {
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
