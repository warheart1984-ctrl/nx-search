# nx-search

Fast local file search with full-text indexing across multiple drives. Index your files once, search instantly.

## Features

- **Fast indexing** - Index hundreds of thousands of files in minutes
- **Dual search** - Search both filenames and file contents simultaneously  
- **Multi-drive support** - Index and search across D:, F:, G: and other drives
- **Document parsing** - Extracts text from PDFs, Word docs, Excel files, images
- **MCP adapter** - Cursor MCP integration for AI assistant workflows
- **SQLite backend** - Efficient storage and retrieval

## Installation

```bash
git clone https://github.com/warheart1984-ctrl/nx-search.git
cd nx-search
npm install
```

## Usage

### Basic Commands

```bash
# Scan and index your drives (Windows defaults to user profile, specify drives for full coverage)
node bin/nx.js scan D: F: G:

# Search for files and content
node bin/nx.js search "your query here"

# Search only by filename
node bin/nx.js search --name-only "filename"

# Check index statistics
node bin/nx.js stats --json
```

### NPM Scripts

```bash
npm run scan -- D: F: G:    # Scan drives
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

- Node.js 18+
- Windows, macOS, or Linux
- 1GB+ RAM for large indexes

## License

ISC

## Contributing

Contributions welcome! Feel free to submit issues and pull requests.