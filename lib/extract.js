import { readFile } from 'node:fs/promises';

export const MAX_BODY_BYTES = 96_000;
export const MAX_EXTRACT_FILE = 50_000_000;

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.cc', '.cs', '.php', '.lua', '.pl', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.r', '.jl', '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.dart',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.astro',
  '.xml', '.svg', '.xsl', '.dtd', '.graphql', '.gql', '.proto', '.tf',
  '.dockerfile', '.makefile', '.cmake', '.gradle', '.sbt', '.tex', '.bib',
  '.srt', '.vtt', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc',
]);

const BINARY_SKIP = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff',
  '.mp3', '.mp4', '.mkv', '.avi', '.mov', '.flac', '.ogg', '.wav', '.wma',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.img', '.deb', '.rpm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3', '.pdb', '.o', '.a', '.class', '.jar',
  '.psd', '.ai', '.sketch', '.blend', '.fbx', '.glb', '.gltf', '.obj', '.stl',
  '.wasm', '.node', '.dmg', '.pkg', '.msi', '.apk', '.bak', '.tmp',
]);

const NO_BODY_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'poetry.lock', 'cargo.lock', 'gemfile.lock', 'pipfile.lock',
]);

const NO_BODY_EXTS = new Set(['.min.js', '.map', '.lock', '.snap', '.sum', '.svg']);

async function extractPdf(path) {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const buf = await readFile(path);
  const out = await mod.default(buf);
  return out.text || '';
}

async function extractDocx(path) {
  const mammoth = await import('mammoth');
  const out = await mammoth.extractRawText({ path });
  return out.value || '';
}

async function extractSheet(path) {
  const XLSX = await import('xlsx');
  const wb = XLSX.readFile(path, { sheetStubs: false });
  const parts = [];
  for (const name of wb.SheetNames) {
    parts.push(`# sheet: ${name}`);
    parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]));
  }
  return parts.join('\n');
}

async function readTextHead(path) {
  const fsp = await import('node:fs/promises');
  const fh = await fsp.open(path, 'r');
  try {
    const buf = Buffer.alloc(MAX_BODY_BYTES);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const data = buf.subarray(0, total);
    if (data.includes(0)) return null;
    const text = data.toString('utf8');
    if (!looksLikeText(text)) return null;
    return text;
  } finally {
    await fh.close();
  }
}

function looksLikeText(text) {
  if (!text.length) return false;
  let bad = 0;
  const n = text.length;
  const step = Math.max(1, Math.floor(n / 20000));
  let sampled = 0;
  for (let i = 0; i < n; i += step) {
    sampled++;
    const c = text.charCodeAt(i);
    if (c === 0xfffd || (c < 9 && c !== 0) || (c > 13 && c < 32 && c !== 27)) bad++;
  }
  return bad / sampled < 0.02;
}

export async function extractText(path, ext, name = '') {
  if (BINARY_SKIP.has(ext)) return { status: 'binary', body: '' };
  if (NO_BODY_NAMES.has(name.toLowerCase()) || NO_BODY_EXTS.has(ext)) {
    return { status: 'catalog_only', body: '' };
  }
  try {
    let body;
    if (ext === '.pdf') body = await extractPdf(path);
    else if (ext === '.docx') body = await extractDocx(path);
    else if (ext === '.xlsx' || ext === '.xls') body = await extractSheet(path);
    else if (ext === '.doc' || ext === '.odt' || ext === '.pptx') return { status: 'unsupported', body: '' };
    else if (TEXT_EXTS.has(ext) || ext === '') {
      const text = await readTextHead(path);
      if (text === null) return { status: 'binary', body: '' };
      body = text;
    } else {
      const stat = await import('node:fs/promises').then((m) => m.stat(path));
      if (stat.size > 5_000_000) return { status: 'skipped_large', body: '' };
      const text = await readTextHead(path).catch(() => null);
      if (!text) return { status: 'binary', body: '' };
      body = text;
    }
    if (!body || !body.trim()) return { status: 'empty', body: '' };
    if (!looksLikeText(body)) return { status: 'binary', body: '' };
    return { status: 'ok', body: body.slice(0, MAX_BODY_BYTES) };
  } catch (err) {
    return { status: `error:${err.code || 'unknown'}`, body: '' };
  }
}
