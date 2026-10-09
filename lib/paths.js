import { homedir } from 'node:os';
import path from 'node:path';

// Where nx-search keeps its own files. policy.js needs these to keep them out of the index, and db.js needs them to open
// the database; this module imports nothing from either, so there is no import cycle.
export function dbPath() {
  return process.env.NX_SEARCH_DB || path.join(homedir(), '.local', 'share', 'nx-search', 'index.db');
}

export function auditLogPath() {
  return process.env.NX_AUDIT_LOG || path.join(homedir(), '.local', 'share', 'nx-search', 'audit.log');
}
