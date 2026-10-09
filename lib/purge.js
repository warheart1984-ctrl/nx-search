// Remove what the current policy would not have indexed, and redact what is stored.
//
// The index is a copy of file contents, so tightening the rules does nothing for rows that are already in it.
// This applies today's policy to every stored row: rows for secret files, directories the policy denies, files
// outside the configured roots and gitignored paths are deleted; bodies that still contain a secret are rewritten
// redacted. Deleted text can linger in the SQLite file, so the FTS index is optimized and the file vacuumed.
import { getPolicy } from './policy.js';

// requireRoots: with no allowlist every stored path would count as outside it and the whole index would be deleted.
export function purgeUnsafe(db, { dryRun = false, policy = getPolicy({ requireRoots: true }) } = {}) {
  const rows = db.prepare('SELECT id, path FROM files').all();
  const delContent = db.prepare('DELETE FROM content WHERE rowid = ?');
  const delFile = db.prepare('DELETE FROM files WHERE id = ?');
  const getBody = db.prepare('SELECT body FROM content WHERE rowid = ?');
  const putBody = db.prepare('INSERT INTO content (rowid, path, body) VALUES (?, ?, ?)');
  const reasons = {};
  let deleted = 0;
  let redacted = 0;

  const work = () => {
    for (const row of rows) {
      const why = policy.fileViolation(row.path, { deep: true });
      if (why) {
        reasons[why] = (reasons[why] ?? 0) + 1;
        deleted += 1;
        if (!dryRun) {
          delContent.run(row.id);
          delFile.run(row.id);
        }
        continue;
      }
      const body = getBody.get(row.id)?.body;
      if (typeof body !== 'string') continue;
      const clean = policy.redact(body);
      if (clean !== body) {
        redacted += 1;
        if (!dryRun) {
          delContent.run(row.id);
          putBody.run(row.id, row.path, clean);
        }
      }
    }
  };
  if (typeof db.transaction === 'function') db.transaction(work)();
  else work();

  let compacted = false;
  if (!dryRun && (deleted > 0 || redacted > 0)) {
    try {
      db.exec("INSERT INTO content(content) VALUES('optimize')");
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      compacted = true;
    } catch {
      /* reported through `compacted: false` */
    }
  }
  // rows that remain (projected, in a dry run)
  const total = dryRun ? rows.length - deleted : db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
  return { total, deleted, redacted, reasons, compacted, dryRun };
}
