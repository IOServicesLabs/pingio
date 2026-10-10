# Testing Pingio with Claude Code

> **Plugin shortcut:** the quickest way to try Pingio in Claude Code is the plugin —
> `claude --plugin-dir ./plugins/pingio` from the repo root (dev mode), or
> `/plugin marketplace add IOServicesLabs/pingio` once the repo is public. See
> `plugins/pingio/README.md`. The manual setup below is for hacking on the MCP
> server itself.

## Step 1: Start the Infrastructure

```bash
cd infrastructure/docker
docker compose up -d
```

Verify services are running:
```bash
docker compose ps
docker compose logs -f relay
```

The relay listens on host port **5000** (compose maps 5000 → container 3000; WebSocket endpoint: `ws://localhost:5000/ws`).

## Step 2: Build the Packages

```bash
# From the repo root — builds shared, then all dependents, in order
npm run build
```

## Step 3: Configure Claude Code MCP

Register the MCP server with the Claude Code CLI (from the repo root):

```bash
claude mcp add pingio -- node "$PWD/packages/mcp-server/dist/server.js"
```

Or add it to a project-scoped `.mcp.json` file:

```json
{
  "mcpServers": {
    "pingio": {
      "command": "node",
      "args": ["C:/path/to/Lemmetalk/packages/mcp-server/dist/server.js"],
      "env": {
        "PINGIO_MODE": "self-hosted",
        "PINGIO_SELF_HOSTED_RELAY_URL": "ws://localhost:5000/ws"
      }
    }
  }
}
```

**Notes:**
- The server key is `pingio` — tools appear as `mcp__pingio__*`.
- The env vars are real: `PINGIO_MODE` + `PINGIO_SELF_HOSTED_RELAY_URL` are read at
  startup (see `packages/mcp-server/src/config.ts`). Without them, the MCP server
  boots in cloud mode against the default hosted relay.
- Adjust the path to match your actual directory.

## Step 4: Test in Claude Code

Once configured, restart Claude Code or run `/mcp` to see available tools. Then test:

### Test 1: Registration
```
register_user(username="alice", password="SecurePass123!")
```

### Test 2: Add Contact (will need mutual contact)
```
add_contact(username="bob")
```

### Test 3: Try to Message (should fail - not mutual)
```
send_message(recipient="bob", content="Hello!")
```
Expected: Error about mutual contact required

### Test 4: Device Management
```
list_devices()
```

## Step 5: Two-User Testing

Since Claude Code runs in a single session, you have two options:

### Option A: Use Two Claude Code Windows
1. Open two separate Claude Code sessions
2. Register User A in window 1
3. Register User B in window 2
4. Have both add each other as contacts
5. Test messaging

### Option B: Use the REST API Directly

Test via curl from another terminal:

```bash
# Register user B
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"SecurePass123!","deviceFingerprint":"test-device"}'

# Login user B
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"SecurePass123!","deviceFingerprint":"test-device"}'

# Add contact (using token from login)
curl -X POST http://localhost:5000/api/contacts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_B_TOKEN>" \
  -d '{"username":"alice"}'
```

Then in Claude Code, User A can message User B.

## Step 6: Test Device Verification

1. Stop and restart with device verification:
```bash
cd infrastructure/docker
DEVICE_VERIFICATION_REQUIRED=true docker compose up -d
```

2. Register a user in Claude Code (first device - auto-verified)

3. Simulate a new device: the MCP server's device fingerprint is derived from its
   local identity store (`~/.pingio/`). Move that directory aside (or point
   `PINGIO_CONFIG_DIR` at a fresh path) so the server generates a new fingerprint,
   then restart Claude Code.

4. Try to login - should get device verification required error

5. Use `list_devices()` to see pending device

6. Use `verify_device(deviceId="xxx")` to approve

## Quick Test Commands

```
# Check status
whoami()

# Register
register_user(username="testuser", password="TestPass123!")

# Search for users
search_users(query="alice")

# Add contact
add_contact(username="bob", customName="Bob Smith")

# List contacts
list_contacts()

# Send message
send_message(recipient="bob", content="Hello from Claude Code!")

# Get history
get_history(contact="bob", limit=10)

# Device management
list_devices()
revoke_device(deviceId="xxx")

# Channels
create_channel(name="general", displayName="General Chat", isPublic=true)
list_channels()
send_channel_message(channelId="xxx", content="Hello everyone!")
```

## Troubleshooting

**Issue: MCP server not connecting**
- Check relay is running: `docker compose ps`
- Check logs: `docker compose logs relay`
- Verify port 5000 is accessible
- Verify `PINGIO_MODE=self-hosted` and `PINGIO_SELF_HOSTED_RELAY_URL=ws://localhost:5000/ws`
  are set, or the MCP server will try the hosted cloud relay instead

**Issue: Device verification loop**
- Set `DEVICE_VERIFICATION_REQUIRED=false` in docker-compose.yml for testing

**Issue: Cannot find module errors**
- Make sure you built all packages: `npm run build` from the repo root

**Issue: Database connection errors**
- Check postgres is healthy: `docker compose ps`
- May need to wait 10-20 seconds for postgres to initialize
