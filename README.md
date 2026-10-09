# nx-search

Fast local file search with full-text indexing across multiple drives. Index your files once, search instantly.

## Features

- **Fast indexing** - Index hundreds of thousands of files in minutes
- **Dual search** - Search both filenames and file contents simultaneously  
- **Multi-drive support** - Index and search across D:, F:, G: and other drives
- **Document parsing** - Extracts text from PDFs, Word docs, Excel files, images
- **MCP adapter** - Cursor MCP integration for AI assistant workflows
- **SQLite backend** - Efficient storage and retrieval
- **Security hardened** - Configurable scope, secret exclusion, content redaction, audit logging, rate limiting

## Security Hardening

nx-search now includes comprehensive security features to protect sensitive data:

- **Scope allowlist** - Only index directories specified in the config file (nx-search-config.json). No default indexing.
- **Secret file exclusion** - Built-in patterns exclude .env, *.pem, *.key, credentials*.json, and other secret files.
- **Content redaction** - Secrets found in files are redacted in the index (e.g., passwords, API keys).
- **System path protection** - Hard-deny list prevents indexing of Windows system directories, Program Files, etc.
- **Gitignore respect** - Respects .gitignore files by default.
- **Index encryption** - Optional encryption support (requires SQLCipher or set NX_SEARCH_ENCRYPTION_KEY).
- **Audit logging** - All searches and scans are logged to ~/.local/share/nx-search/audit.log.
- **Rate limiting** - Configurable queries per minute limit.
- **Result caps** - Maximum results per query configurable.
- **Purge-unsafe command** - `nx purge-unsafe` removes already-indexed sensitive data.

## Installation

```bash
git clone https://github.com/warheart1984-ctrl/nx-search.git
cd nx-search
npm install
```

## Usage

### Configuration

Create a `.nx-search-config.json` file in your home directory or project root:

```json
{
  "roots": [
    "C:\\Users\\%USERNAME%\\Documents",
    "G:\\Project Finish"
  ],
  "secret_exclude_patterns": [
    "*.env*",
    "*.pem",
    "*.key",
    "credentials*.json",
    "*secret*",
    ".ssh/*",
    ".aws/*"
  ],
  "extra_skip_dirs": [],
  "security": {
    "encryption": false,
    "search_result_cap": 50,
    "rate_limit_qpm": 60,
    "audit_logging": true,
    "redaction_patterns": [
      "-----BEGIN .*PRIVATE KEY-----",
      "AKIA[0-9A-Z]{16}",
      "ghp_|github_pat_",
      "sk-|xox[bp]-",
      "(api_key|password|secret|token)\\s*[:=]\\s*\\S+"
    ]
  }
}
```

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

- Node.js 22.13+ (uses the built-in `node:sqlite`)
- Windows, macOS, or Linux
- 1GB+ RAM for large indexes

## License

ISC

## Contributing

Contributions welcome! Feel free to submit issues and pull requests.