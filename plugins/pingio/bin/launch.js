#!/usr/bin/env node
/**
 * Pingio MCP server launcher.
 *
 * Resolution order:
 *   1. $PINGIO_MCP_ENTRY — explicit path to a built server.js
 *   2. <plugin>/../../packages/mcp-server/dist/server.js — dev inside a
 *      monorepo checkout (plugin installed straight from the cloned repo)
 *   3. npx -y @pingio/mcp-server — the published npm package
 *
 * The selected server's stdin/stdout/stderr are inherited, so the MCP host
 * talks to the server transparently; this process exits with the server.
 */
const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const PLUGIN_ROOT = join(__dirname, '..');
const MONOREPO_ENTRY = join(
  PLUGIN_ROOT,
  '..',
  '..',
  'packages',
  'mcp-server',
  'dist',
  'server.js'
);
const NPM_PACKAGE = '@pingio/mcp-server';

function resolve() {
  const envEntry = process.env.PINGIO_MCP_ENTRY;
  if (envEntry) {
    if (!existsSync(envEntry)) {
      console.error(`[pingio] PINGIO_MCP_ENTRY does not exist: ${envEntry}`);
      process.exit(1);
    }
    return { command: process.execPath, args: [envEntry] };
  }

  if (existsSync(MONOREPO_ENTRY)) {
    return { command: process.execPath, args: [MONOREPO_ENTRY] };
  }

  // Node >= 18.20/20.x refuses to spawn .cmd/.bat without a shell on Windows
  // (CVE-2024-27980), so go through the shell there.
  const isWindows = process.platform === 'win32';
  return {
    command: isWindows ? 'npx.cmd' : 'npx',
    args: ['-y', NPM_PACKAGE],
    shell: isWindows,
  };
}

const { command, args, shell } = resolve();
const child = spawn(command, args, { stdio: 'inherit', shell });

child.on('error', (err) => {
  console.error(`[pingio] failed to start MCP server: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code === null ? 1 : code);
});
