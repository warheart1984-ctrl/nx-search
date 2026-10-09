import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { auditLogPath } from './paths.js';
export { auditLogPath };

let warned = false;
const tightened = new Set();

/**
 * Append one audit record. Queries are stored as a hash and a length unless the config sets audit_log_queries,
 * because a search for a password is itself sensitive. A failed write is reported on stderr (once), never swallowed.
 */
export function audit({ op, caller = 'unknown', query, result }, security) {
  if (!security || security.audit_logging === false) return;
  const entry = { timestamp: new Date().toISOString(), op, caller: String(caller).slice(0, 64) };
  if (typeof query === 'string') {
    entry.queryHash = createHash('sha256').update(query).digest('hex');
    entry.queryLength = query.length;
    if (security.audit_log_queries === true) entry.query = query;
  }
  if (result !== undefined) entry.result = result;
  try {
    const file = auditLogPath();
    // The log can hold search terms: private to the owner (0700 directory it creates, 0600 file), also when it already
    // existed with looser permissions. Windows ACLs are inherited from the folder, so modes are not applied there.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32' && !tightened.has(file)) {
      chmodSync(file, 0o600);
      tightened.add(file);
    }
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(`nx-search: audit log write failed (${err.message}); this and later operations are NOT being audited`);
    }
  }
}
