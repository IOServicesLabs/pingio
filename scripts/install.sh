#!/bin/bash
# Pingio Server 1-Shot Installer

echo "🚀 Installing Pingio MCP Server..."

if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is required but not installed."
    exit 1
fi

node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
const SERVER_NAME = 'pingio';
const MCP_CONFIG = {
  command: os.platform() === 'win32' ? 'npx.cmd' : 'npx',
  args: ['-y', '@pingio/mcp-server'],
  env: {}
};

function updateConfig(configPath) {
  try {
    let data = {};
    if (fs.existsSync(configPath)) {
      try { data = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch(e){}
    } else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[SERVER_NAME] = MCP_CONFIG;
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
    console.log('✅ Updated ' + configPath);
  } catch (e) {
    console.error('❌ Failed to update ' + configPath);
  }
}

const platform = os.platform();
let claudePath = platform === 'win32' 
  ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
  : platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');

updateConfig(claudePath);
updateConfig(path.join(os.homedir(), '.cursor', 'mcp.json'));
updateConfig(path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'));
"

echo "🎉 Installation complete! Please restart Claude Desktop, Cursor, or Windsurf."
