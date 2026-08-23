import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DB_PATH =
  process.env.NX_SEARCH_DB || join(homedir(), '.local', 'share', 'nx-search', 'index.db');

export function openDb({ durable = true } = {}) {
  mkdirSync(join(DB_PATH, '..'), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma(durable ? 'synchronous = NORMAL' : 'synchronous = OFF');
  db.pragma('cache_size = -131072');
  db.pragma('mmap_size = 268435456');
  migrate(db);
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
