import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadNxEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, '..', '.env'),
    join(homedir(), '.config', 'nx-search', '.env'),
  ];
  for (const file of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
      }
    } catch {
      // optional env files
    }
  }
}
