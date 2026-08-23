import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), '.local', 'share', 'nx-search');
const REPLAY = join(DIR, 'replay.jsonl');
const MEMORY = join(DIR, 'memory.json');

export function classifyIntent(q) {
  const s = q.toLowerCase().trim();
  if (/^(hi|hello|hey|yo|sup)\b/.test(s)) return { mode: 'chat', useRetrieval: false };

  const fileSignal = /\b(file|files|folders?|paths?|directories?|drives?|documents?|docs?|pdfs?|spreadsheets?|xlsx|code|scripts?|projects?|repos?|screenshots?|images?|photos?|pictures?|logs?|notes?|whitepapers?|specs?|contracts?|where is|where are|find|locate|which file|show me|list)\b/.test(s);
  const codeSignal = /\b(functions?|classes?|bugs?|errors?|exceptions?|stack ?traces?|compil\w*|refactor\w*|implement\w*|api|npm|git|regex|typescript|javascript|python|tests?)\b/.test(s);
  const creativeSignal = /\b(poems?|stor(y|ies)|limericks?|songs?|jokes?|haiku|brainstorm\w*|imagine|roleplay)\b/.test(s);

  if (creativeSignal && !fileSignal) return { mode: 'creative', useRetrieval: false };
  if (codeSignal) return { mode: 'code', useRetrieval: true };
  if (fileSignal) return { mode: 'file_research', useRetrieval: true };
  return { mode: 'chat', useRetrieval: false };
}

export function modeConfig(mode) {
  return {
    chat: { temperature: 0.6, max_tokens: 1024 },
    creative: { temperature: 1.0, max_tokens: 2048 },
    code: { temperature: 0.15, max_tokens: 2500 },
    file_research: { temperature: 0.2, max_tokens: 1800 },
  }[mode] || { temperature: 0.3, max_tokens: 1500 };
}

export function loadMemory() {
  try {
    return JSON.parse(readFileSync(MEMORY, 'utf8'));
  } catch {
    return {};
  }
}

export function remember(key, value) {
  const m = loadMemory();
  m[key.trim()] = value.trim();
  mkdirSync(DIR, { recursive: true });
  writeFileSync(MEMORY, JSON.stringify(m, null, 2));
  return m;
}

export function forget(key) {
  const m = loadMemory();
  delete m[key.trim()];
  writeFileSync(MEMORY, JSON.stringify(m, null, 2));
  return m;
}

export function memoryBlock() {
  const entries = Object.entries(loadMemory());
  if (!entries.length) return '';
  return `\n\nKNOWN USER PREFERENCES (from persistent memory):\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}

export function logReplay(entry) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(REPLAY, `${JSON.stringify(entry)}\n`);
  } catch {}
}
