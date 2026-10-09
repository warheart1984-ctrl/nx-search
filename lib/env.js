import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

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
  
  // Load nx-search config if not already loaded
  if (!process.env.NX_SEARCH_CONFIG_LOADED) {
    const CONFIG_PATH = process.env.NX_SEARCH_CONFIG || join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
    try {
      const cfgRaw = require(CONFIG_PATH);
      process.env.NX_SEARCH_CONFIG_LOADED = 'true';
      // Could store config in process.env for other modules
    } catch (e) {
      // No config file
    }
  }
}