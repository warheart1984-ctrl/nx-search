#!/usr/bin/env node
import { loadNxEnv } from '../lib/env.js';
import { startMcpStdio } from '../lib/mcp.js';

loadNxEnv();
startMcpStdio().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
