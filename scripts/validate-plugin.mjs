#!/usr/bin/env node
/**
 * Validates the Pingio plugin packaging: every manifest parses as JSON and
 * carries the fields its ecosystem requires, the launcher exists, and the
 * two marketplace catalogs point at the plugin directory.
 *
 * Usage: node scripts/validate-plugin.mjs   (or: npm run test:plugin)
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugins', 'pingio');

let failures = 0;

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function readJson(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    check(relPath, false, 'file missing');
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf-8'));
    check(`${relPath} parses`, true);
    return parsed;
  } catch (err) {
    check(`${relPath} parses`, false, err.message);
    return null;
  }
}

console.log('Pingio plugin packaging validation\n');

// --- Claude Code plugin ---
console.log('Claude Code plugin:');
const claudeManifest = readJson('plugins/pingio/.claude-plugin/plugin.json');
if (claudeManifest) {
  check('name is pingio', claudeManifest.name === 'pingio');
  check('has version', typeof claudeManifest.version === 'string');
  check('has description', typeof claudeManifest.description === 'string');
}
const claudeMcp = readJson('plugins/pingio/.mcp.json');
if (claudeMcp) {
  const server = claudeMcp.mcpServers?.pingio;
  check('mcpServers.pingio exists', !!server);
  check(
    'launcher uses ${CLAUDE_PLUGIN_ROOT}',
    Array.isArray(server?.args) &&
      server.args.some((a) => a.includes('${CLAUDE_PLUGIN_ROOT}'))
  );
}

// --- Codex / portable plugin ---
console.log('\nCodex (portable) plugin:');
const portableManifest = readJson('plugins/pingio/plugin.json');
if (portableManifest) {
  check('name is pingio', portableManifest.name === 'pingio');
  check('has version', typeof portableManifest.version === 'string');
}
const portableMcp = readJson('plugins/pingio/mcp.json');
if (portableMcp) {
  const server = portableMcp.mcpServers?.pingio;
  check('mcpServers.pingio exists', !!server);
  check('transport type is stdio', server?.type === 'stdio');
}

// --- Shared components ---
console.log('\nShared components:');
check('bin/launch.js exists', existsSync(join(PLUGIN, 'bin', 'launch.js')));
check('skills/pingio/SKILL.md exists', existsSync(join(PLUGIN, 'skills', 'pingio', 'SKILL.md')));
check('commands/setup.md exists', existsSync(join(PLUGIN, 'commands', 'setup.md')));
check('commands/status.md exists', existsSync(join(PLUGIN, 'commands', 'status.md')));

// --- Marketplace catalogs ---
console.log('\nMarketplace catalogs:');
const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
if (claudeMarketplace) {
  const entry = claudeMarketplace.plugins?.find((p) => p.name === 'pingio');
  check('lists pingio plugin', !!entry);
  check('source points at ./plugins/pingio', entry?.source === './plugins/pingio');
}
const codexMarketplace = readJson('.agents/plugins/marketplace.json');
if (codexMarketplace) {
  const entry = codexMarketplace.plugins?.find((p) => p.name === 'pingio');
  check('lists pingio plugin', !!entry);
  check('source.path points at ./plugins/pingio', entry?.source?.path === './plugins/pingio');
  check('has policy.installation', typeof entry?.policy?.installation === 'string');
  check('has category', typeof entry?.category === 'string');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
