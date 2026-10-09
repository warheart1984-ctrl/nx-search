import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_PATH = join(homedir(), '.local', 'share', 'nx-search', 'memory.json');

function loadMemory() {
  try {
    return JSON.parse(readFileSync(MEMORY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveMemory(memory) {
  mkdirSync(join(homedir(), '.local', 'share', 'nx-search'), { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

// CLI interface
const args = process.argv.slice(2);
const command = args[0];

if (command === 'get') {
  const key = args[1];
  const memory = loadMemory();
  if (key) {
    console.log(memory[key] || '');
  } else {
    console.log(JSON.stringify(memory, null, 2));
  }
} else if (command === 'set') {
  const key = args[1];
  const value = args.slice(2).join(' ');
  if (key && value) {
    const memory = loadMemory();
    memory[key.trim()] = value.trim();
    saveMemory(memory);
    console.log(`Remembered: ${key} = ${value}`);
  } else {
    console.error('Usage: node memory-utility.js set <key> <value>');
    process.exit(1);
  }
} else if (command === 'delete') {
  const key = args[1];
  if (key) {
    const memory = loadMemory();
    delete memory[key.trim()];
    saveMemory(memory);
    console.log(`Forgot: ${key}`);
  } else {
    console.error('Usage: node memory-utility.js delete <key>');
    process.exit(1);
  }
} else {
  console.log('Usage: node memory-utility.js <get|set|delete> [key] [value]');
  process.exit(1);
}
