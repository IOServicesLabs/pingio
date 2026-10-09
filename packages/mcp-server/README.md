# @pingio/mcp-server

The Pingio MCP server — ping your team, right in their terminal. Gives any
MCP-capable AI client (Claude Code, Codex, Claude Desktop, Cursor, …) secure
E2E-encrypted DMs and channels, build-group task handoffs, work-context
sharing, and presence.

## Install

```bash
npx -y @pingio/mcp-server
```

Most clients take an MCP server config entry:

```json
{
  "mcpServers": {
    "pingio": {
      "command": "npx",
      "args": ["-y", "@pingio/mcp-server"]
    }
  }
}
```

Using Claude Code or Codex? Skip the manual wiring and install the plugin
instead — see [plugins/pingio](https://github.com/IOServicesLabs/pingio/tree/main/plugins/pingio).

## First run

The server idles until you authenticate through its tools — ask your agent to
`register_user` (new account) or `login`. Credentials persist in
`~/.pingio/config.json` and later sessions reconnect automatically.

## Configuration

Config file: `~/.pingio/config.json`. Environment variables override it:

| Env var | Purpose |
|---|---|
| `PINGIO_MODE` | `cloud` \| `self-hosted` \| `auto` (default `auto`) |
| `PINGIO_CLOUD_ENDPOINT` | Central auth server URL |
| `PINGIO_CLOUD_RELAY_URL` | Cloud relay WebSocket URL |
| `PINGIO_SELF_HOSTED_RELAY_URL` | Your own relay, e.g. `ws://localhost:5000/ws` |
| `PINGIO_SELF_HOSTED_AUTH_URL` | Your relay's auth base URL |
| `PINGIO_ENABLE_LOCAL_P2P` | `1`/`0` — LAN peer discovery toggle |

## Docs

Full documentation, self-hosting guides (Docker, Railway, Render, Fly.io), and
the relay/auth server sources: <https://github.com/IOServicesLabs/pingio>

## License

MIT
