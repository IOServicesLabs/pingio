# LLM Integration Guide

This guide explains how to integrate the Pingio Server with various LLMs and IDEs like Claude Desktop, Cursor, Windsurf, ChatGPT, and OpenWebUI.

> **Using Claude Code or Codex?** Skip this guide and install the plugin instead — it bundles the MCP server plus a usage skill and setup commands. See the [plugin README](plugins/pingio/README.md).

## 1-Shot Automated Setup (Easiest)

If you don't want to clone the repository or build the code yourself, simply run one of the commands below. It will automatically detect your OS and configure your installed LLM clients (Claude Desktop, Cursor, and Windsurf) to pull and run the `pingio` via `npx`.

**Mac / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/IOServicesLabs/pingio/main/scripts/install.sh | bash
```

**Windows (run in PowerShell):**
```powershell
irm https://raw.githubusercontent.com/IOServicesLabs/pingio/main/scripts/install.ps1 | iex
```

Restart your LLM client (Claude Desktop / Cursor) after running the script!

---

## Local Automated Setup

If you have cloned the repository locally and wish to link your clients directly to your local build:

```bash
# First, ensure the MCP server is built:
npm run build

# Then run the automated setup script:
npm run setup:llms
```

---

## Manual Setup

Depending on the tool, you will need to give it the command and arguments required to launch the MCP server.

**Local Project Path:**
- **Command:** `node`
- **Args:** `["/absolute/path/to/Pingio/packages/mcp-server/dist/server.js"]`

**Or using NPX (if published or installed globally):**
- **Command:** `npx`
- **Args:** `["-y", "@pingio/mcp-server"]`

### 1. Claude Desktop

The configuration file is typically located at:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the following to the `mcpServers` object inside the config:

```json
{
  "mcpServers": {
    "pingio": {
      "command": "node",
      "args": ["<absolute_path_to_Pingio>/packages/mcp-server/dist/server.js"],
      "env": {}
    }
  }
}
```

### 2. Cursor

In the Cursor UI:
1. Open **Cursor Settings** (gear icon).
2. Go to **Features** > **MCP Servers**.
3. Click **Add New MCP Server**.
4. Set Name to `pingio`.
5. Set Type to `stdio`.
6. Set Command to `node <absolute_path_to_Pingio>/packages/mcp-server/dist/server.js`.
7. Click Save and Refresh.

*(Alternatively, standard installations may respect the `~/.cursor/mcp.json` file added by the script).*

### 3. OpenWebUI or "OpenClaw"

Many specialized frontend clients that support MCP via standard UI configurations will ask for a **Startup Command**. 
Simply provide:
```bash
node /path/to/Pingio/packages/mcp-server/dist/server.js
```

### 4. ChatGPT

*Note: As of writing, ChatGPT's primary web interface does not natively support third-party MCP protocols directly unless via a specific OpenAI custom action / plugin architecture.*

If you are using a ChatGPT client wrapper or a custom environment that *does* support MCP (e.g., terminal wrappers, specialized desktop clients), use the standard `stdio` command above.
To expose this server as a **REST API** for typical ChatGPT Custom GPTs to hit, please use the `relay-server` endpoints configured over HTTPS, or deploy the service using the instructions in the main README.

---
### Verifying it Works
1. Once hooked up to your client, ask the LLM: *"Can you list my contacts using the Pingio server?"*
2. If it is able to query the list, your integration is successfully configured!
