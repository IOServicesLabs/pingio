# Pingio plugin

Ping your team — right in their terminal. This plugin gives your AI client the full
Pingio toolset: E2E-encrypted DMs and channels, build-group task handoffs, work-context
sharing, and presence — plus a skill that teaches the agent how to use them.

Works with **Claude Code** and **Codex** from the same directory.

## Install

### Claude Code

```text
/plugin marketplace add IOServicesLabs/pingio
/plugin install pingio@pingio
```

Then run `/pingio:setup` to register or log in.

### Codex

```text
codex plugin marketplace add IOServicesLabs/pingio
```

Then enable it in `~/.codex/config.toml`:

```toml
[plugins."pingio@pingio"]
enabled = true
```

## Running from a local checkout (no npm publish needed)

The plugin's launcher (`bin/launch.js`) resolves the server in this order:

1. `PINGIO_MCP_ENTRY` env var — absolute path to a built `server.js`
2. A sibling monorepo build at `packages/mcp-server/dist/server.js`
   (automatic when the plugin lives in a cloned pingio repo)
3. `npx -y pingio-mcp-server` — the published package

So from a clone:

```bash
npm install
npm run build --workspace=@pingio/shared --workspace=pingio-mcp-server
claude --plugin-dir ./plugins/pingio        # Claude Code dev load
codex plugin marketplace add /path/to/pingio # Codex: add the clone as a local marketplace
```

## Configuration

The MCP server reads `~/.pingio/config.json` (created on first login). These env
vars override it — handy for pointing a plugin install at your own relay:

| Env var | Purpose |
|---|---|
| `PINGIO_MODE` | `cloud` \| `self-hosted` \| `auto` |
| `PINGIO_CLOUD_ENDPOINT` | Central auth server URL |
| `PINGIO_CLOUD_RELAY_URL` | Cloud relay WebSocket URL |
| `PINGIO_SELF_HOSTED_RELAY_URL` | Your relay, e.g. `ws://localhost:5000/ws` |
| `PINGIO_SELF_HOSTED_AUTH_URL` | Your relay's auth base URL |
| `PINGIO_ENABLE_LOCAL_P2P` | `1`/`0` — LAN peer discovery toggle |

Example `.mcp.json`-style env block for a self-hosted team:

```json
{
  "mcpServers": {
    "pingio": {
      "command": "node",
      "args": ["<plugin>/bin/launch.js"],
      "env": {
        "PINGIO_MODE": "self-hosted",
        "PINGIO_SELF_HOSTED_RELAY_URL": "wss://relay.internal.example.com/ws"
      }
    }
  }
}
```

## What's in the box

- **MCP server** — all `pingio` tools (messaging, channels, encryption, build groups, context sharing, agent mode)
- **`pingio` skill** — teaches the agent the workflows (loaded by both clients)
- **`/pingio:setup`, `/pingio:status`** — slash commands (Claude Code)

Server, self-hosting, and deployment docs live in the
[main repo](https://github.com/IOServicesLabs/pingio).
