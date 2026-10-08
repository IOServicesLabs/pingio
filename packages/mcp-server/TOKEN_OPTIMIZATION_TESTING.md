# Token Optimization Testing Guide

## Quick Test

Run the token comparison script:

```bash
cd C:\path\to\pingio
node test-token-optimization.mjs
```

Expected output shows ~63% token savings.

## Unit Tests

Install vitest (if not already installed):

```bash
cd packages/mcp-server
npm install --save-dev vitest
```

Run tests:

```bash
npm test
```

## Manual Testing via MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the best way to test the changes:

```bash
# Install inspector globally
npm install -g @modelcontextprotocol/inspector

# Run inspector with the mcp-server
cd packages/mcp-server
npx @modelcontextprotocol/inspector node dist/server.js
```

Then test each tool:

### 1. Send Message
- Call `send_message` with recipient="testuser" and content="Hello"
- **Expected**: Response should be `✓ @testuser` (not a verbose message)

### 2. Get History
- Call `get_history` with contact="testuser"
- **Expected**:
  - Format: `HH:MM username: message content`
  - No header text like "Message history with @user:"
  - No "(edited)" suffixes
  - Compact timestamps (not full locale strings)

### 3. List Contacts
- Call `list_contacts`
- **Expected**:
  - Format: `username status unreadCount` (one per line)
  - No "Your Contacts:" header
  - No markdown bullets
  - Unread count only shown if > 0

### 4. Add Contact
- Call `add_contact` with username="newuser"
- **Expected**: `✓ @newuser` (no instructions/examples)

### 5. Block Contact
- Call `block_contact` with username="user" and block=true
- **Expected**: `✓ blocked @user`

## Integration Test (Full Flow)

```javascript
// Simulated conversation flow
1. add_contact(username="alice")
   // Expected: ✓ @alice

2. send_message(recipient="alice", content="Hello!")
   // Expected: ✓ @alice

3. get_history(contact="alice")
   // Expected: Compact format messages like:
   // 10:30 alice: Hi there!
   // 10:31 testuser: Hello!

4. list_contacts()
   // Expected:
   // alice online 2
   // bob away

5. block_contact(username="bob", block=true)
   // Expected: ✓ blocked @bob
```

## Token Counting

To verify actual token counts (approximation):

```javascript
// In browser console or Node.js
function countTokens(text) {
  // GPT-style tokenization approximation
  return text.split(/(\s+|\W+)/).filter(t => t.trim().length > 0).length;
}

// Compare old vs new
const old = 'Message sent to @alice!'; // ~6 tokens
const new_ = '✓ @alice';                // ~2 tokens

console.log('Savings:', countTokens(old) - countTokens(new_));
```

## Regression Tests

Ensure these behaviors still work:

1. **Error messages**: Should still be descriptive (not optimized, since errors need context)
2. **Contact not found**: Should still say `Contact "name" not found`
3. **Not logged in**: Should still say `Error: Not logged in`
4. **History limit**: Default should now be 20 (not 50)

## Performance Comparison

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| send_message | 6 tokens | 2 tokens | 67% |
| add_contact | 26 tokens | 2 tokens | 92% |
| list_contacts (10) | ~100 tokens | ~25 tokens | 75% |
| get_history (20 msgs) | ~400 tokens | ~120 tokens | 70% |
| Full conversation | ~500 tokens | ~150 tokens | 70% |

## CI/CD Test

Add to GitHub Actions or similar:

```yaml
- name: Test Token Optimization
  run: |
    cd packages/mcp-server
    npm run typecheck
    npm test
    node ../../test-token-optimization.mjs
```
