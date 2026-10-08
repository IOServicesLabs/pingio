import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const serverPath = path.join(rootDir, 'packages', 'mcp-server', 'dist', 'server.js');

const SERVER_NAME = 'pingio';
const MCP_CONFIG = {
  command: "node",
  args: [serverPath],
  env: {}
};

async function updateJsonFile(filePath, updateFn) {
  try {
    let raw = '{}';
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // If the file or directory doesn't exist, we might need to create the directory
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }
    
    // Some configs might be empty or invalid JSON
    let data = {};
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.warn(`Warning: Could not parse ${filePath}, overwriting...`);
      }
    }

    const newData = updateFn(data);
    await fs.writeFile(filePath, JSON.stringify(newData, null, 2), 'utf-8');
    console.log(`✅ Successfully updated ${filePath}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to update ${filePath}:`, error.message);
    return false;
  }
}

async function setupClaudeDesktop() {
  console.log('\n--- Setting up Claude Desktop ---');
  let configPath;
  const platform = os.platform();
  
  if (platform === 'win32') {
    configPath = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
  } else if (platform === 'darwin') {
    configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else {
    // Linux isn't officially supported by Claude Desktop yet, but standard path or unofficial builds
    configPath = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }

  await updateJsonFile(configPath, (config) => {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[SERVER_NAME] = MCP_CONFIG;
    return config;
  });
}

async function setupCursor() {
  console.log('\n--- Setting up Cursor ---');
  // For Cursor, the user can configure it via Settings -> MCP or sometimes via a workspace config
  // The global config on some versions is at `~/.cursor/mcp.json`
  const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  
  await updateJsonFile(cursorConfigPath, (config) => {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[SERVER_NAME] = MCP_CONFIG;
    return config;
  });
  console.log('Note: Setup for Cursor may require adding it manually via Cursor Settings -> Features -> MCP Servers if this file is ignored.');
}

async function setupWindsurf() {
  console.log('\n--- Setting up Windsurf ---');
  const windsurfConfigPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  
  await updateJsonFile(windsurfConfigPath, (config) => {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[SERVER_NAME] = MCP_CONFIG;
    return config;
  });
}

async function main() {
  console.log('🚀 Setting up MCP server for LLM clients...');
  
  // Ensure the server has been built
  try {
    const stats = await fs.stat(serverPath);
    if (!stats.isFile()) throw new Error('Not a file');
  } catch (e) {
    console.warn(`\n⚠️ Warning: ${serverPath} does not exist.`);
    console.warn('Make sure you have run `npm run build` in the packages/mcp-server directory before using the MCP server inside LLM clients.\n');
  }

  await setupClaudeDesktop();
  await setupCursor();
  await setupWindsurf();
  
  console.log('\n🎉 Setup complete!');
  console.log('\nIf your client (like ChatGPT, OpenClaw, or OpenWebUI) requires manual setup, use these details:');
  console.log(`Type: stdio`);
  console.log(`Command: node`);
  console.log(`Args: [ "${serverPath.replace(/\\/g, '\\\\')}" ]`);
  console.log(`\nAlternatively, if using the npm package directly: npx -y @pingio/mcp-server`);
}

main().catch(console.error);
