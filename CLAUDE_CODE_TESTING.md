# Testing Pingio with Claude Code

## Step 1: Start the Infrastructure

```bash
cd infrastructure/docker
docker-compose up -d
```

Verify services are running:
```bash
docker-compose ps
docker-compose logs -f relay
```

## Step 2: Configure Claude Code MCP

Add to your Claude Code settings file (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "messaging": {
      "command": "node",
      "args": ["C:/path/to/pingio/packages/mcp-server/dist/server.js"],
      "env": {
        "MCP_RELAY_URL": "ws://localhost:5000/ws"
      }
    }
  }
}
```

**Note:** Adjust the path to match your actual directory.

## Step 3: Build the MCP Server

```bash
cd packages/shared
npm run build

cd packages/relay-server
npm run build

cd packages/mcp-server
npm run build
```

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
DEVICE_VERIFICATION_REQUIRED=true docker-compose up -d
```

2. Register a user in Claude Code (first device - auto-verified)

3. Simulate a new device by modifying the device fingerprint. Edit the MCP config temporarily:
```json
{
  "mcpServers": {
    "messaging": {
      "command": "node",
      "args": [".../server.js"],
      "env": {
        "MCP_RELAY_URL": "ws://localhost:5000/ws",
        "FORCE_NEW_DEVICE": "true"
      }
    }
  }
}
```

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
- Check relay is running: `docker-compose ps`
- Check logs: `docker-compose logs relay`
- Verify port 5000 is accessible

**Issue: Device verification loop**
- Set `DEVICE_VERIFICATION_REQUIRED=false` in docker-compose.yml for testing

**Issue: Cannot find module errors**
- Make sure you built all packages: `npm run build` in shared, relay-server, and mcp-server

**Issue: Database connection errors**
- Check postgres is healthy: `docker-compose ps`
- May need to wait 10-20 seconds for postgres to initialize
