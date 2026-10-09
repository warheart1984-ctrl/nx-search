# nx-search

Fast local file search with full-text indexing across multiple drives. Index your files once, search instantly.

## Features

- **Fast indexing** - Index hundreds of thousands of files in minutes
- **Dual search** - Search both filenames and file contents simultaneously  
- **Multi-drive support** - Index and search across D:, F:, G: and other drives
- **Document parsing** - Extracts text from PDFs, Word docs, Excel files, images
- **MCP adapter** - Cursor MCP integration for AI assistant workflows
- **SQLite backend** - Efficient storage and retrieval
- **Security hardened** - Allowlisted scope, secret exclusion, content redaction, audit logging, rate limiting (see below; no index encryption)

## Security Hardening

nx-search copies file contents into a local SQLite index, so what it indexes is what it can leak. One policy (`lib/policy.js`)
is applied by `scan`, `watch`, `purge-unsafe`, search, the web UI's retrieval and the MCP bridge, so a control cannot exist on one
path and be missing on another.

- **Scope allowlist.** Nothing is indexed until `roots` is set in the config. Every path given to `nx scan`, `nx reindex` or
  `nx watch` must be inside a configured root (symlinks resolved, case-insensitive on Windows) or the command stops with `SCOPE_INVALID`.
- **System locations.** Roots under `C:\Windows`, `Program Files`, `ProgramData`, `/proc`, `/sys`, `/dev`, `/run`, `/etc`, `/var` and similar are refused.
- **Secret files.** Built-in patterns (`*.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*.json`, `*secret*`, `.npmrc`, ...) and the directories
  `secrets/`, `passwords/`, `credentials/`, `.ssh`, `.aws`, `.gnupg` are never indexed. Matching is case-insensitive. The config can add patterns, never remove them.
- **`.gitignore`.** Ignored files and directories are skipped (globs, `!` negation, anchored and directory-only patterns).
- **Redaction.** Private-key blocks, AWS keys, GitHub and Slack tokens, `sk-` keys, JWTs and `password`/`token`/`api_key` values are replaced with
  `[REDACTED]` before text is stored, and again when snippets are returned (search, web UI context sent to an LLM, MCP). Add your own regexes under `security.redaction_patterns`.
- **Audit log.** Scans and searches are appended to `~/.local/share/nx-search/audit.log` (override with `NX_AUDIT_LOG`). Queries are stored as a
  hash and a length unless `security.audit_log_queries` is true. If the log cannot be written, a warning is printed.
- **Limits.** `security.rate_limit_qpm` (default 60 per caller per minute) and `security.search_result_cap` (default 50).
- **MCP bridge.** Off unless `JARVIS_NX_ENABLED=1`. It exposes only the read-only tools `nx_search` and `nx_stats`.
- **`nx purge-unsafe [--dry-run]`.** The index is a copy, so tightening the rules does nothing for rows already stored. This removes rows the
  current policy would not allow, redacts stored bodies that still hold a secret, then compacts the index. Run it after upgrading.

**Not provided: index encryption.** Setting `security.encryption` to `true` makes nx-search refuse to open the index. Keep the index on an encrypted volume
if the data needs it. A config file that cannot be read or parsed is an error, never a silent fall back to defaults.

### Configuration

Create the config at `~/.local/share/nx-search/.nx-search-config.json` (or point `NX_SEARCH_CONFIG` at it). See `nx-search-config.example.json`:

```json
{
  "roots": ["C:\\Users\\YOU\\Documents"],
  "secret_exclude_patterns": [],
  "extra_skip_dirs": [],
  "security": {
    "search_result_cap": 50,
    "rate_limit_qpm": 60,
    "audit_logging": true,
    "audit_log_queries": false,
    "redaction_patterns": []
  }
}
```

`%VAR%`, `$VAR` and a leading `~` in `roots` are expanded.

## Installation

```bash
git clone https://github.com/warheart1984-ctrl/nx-search.git
cd nx-search
npm install
```

## Usage

### Basic Commands

```bash
# Scan and index your drives (only within configured roots)
nx scan

# Search for files and content
nx search "your query here"

# Search only by filename
nx search --name-only "filename"

# Check index statistics
nx stats --json

# Keep selected Windows roots current as files change
nx watch "D:\\Evolving Ai" "G:\\Project Finish" --debounce 750

# Drop index rows for files that no longer exist
nx prune "D:\\Evolving Ai"

# Remove already-indexed sensitive data
nx purge-unsafe
```

### NPM Scripts

```bash
npm run scan --    # Scan drives
npm run search -- "query"   # Search
npm test                    # Run tests
```

## Examples

```bash
# Find all Python files containing "authentication"
nx search "authentication" --name-only "*.py"

# Search for "evolving ai" across all indexed drives
nx search "evolving ai"

# Check what's indexed
nx stats --json
```

## MCP Integration

The included MCP adapter allows Cursor and other MCP-compatible tools to search your local drives:

```bash
npm run mcp
```

## Supported File Types

- Text files (.txt, .md, .json, .xml, etc.)
- Code files (.js, .py, .ts, .rs, .cpp, etc.)
- Documents (.pdf, .docx, .xlsx)
- Images (.png, .jpg, .gif) - OCR text extraction

## Performance

Typical performance on modern hardware:
- **Indexing:** ~1000 files/second
- **Search:** Sub-second across 400K+ files
- **Storage:** ~1-2 MB per 1000 files indexed

## Requirements

- Node.js 22.16+ (uses the built-in `node:sqlite`; earlier 22.x builds have no FTS5)
- Windows, macOS, or Linux
- 1GB+ RAM for large indexes

## License

ISC

## Contributing

Contributions welcome! Feel free to submit issues and pull requests.