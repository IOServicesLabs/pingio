#!/bin/bash
# Quick smoke test for the Pingio relay-server (bash).
#
# Requires: bash, curl, jq, and node (the DM step drives the WebSocket with the
#           workspace's `ws` package — run from the repo root).
# On Windows, test-messaging.ps1 does the same REST steps without jq/node.
#
# Direct messaging is NOT a REST endpoint — it runs over the WebSocket (/ws):
# send {"type":"auth","payload":{token,...}}, then {"type":"message",...}.
#
# Prereqs: relay-server running on $RELAY_URL (default http://localhost:5000).
set -euo pipefail

RELAY_URL="${RELAY_URL:-http://localhost:5000}"
WS_URL="${RELAY_URL/http/ws}/ws"

# Unique suffix so the script is re-runnable without username collisions.
SFX=$(date +%H%M%S)
ALICE="alice_$SFX"
BOB="bob_$SFX"

echo "=== Relay: $RELAY_URL ==="

echo ""
echo "=== Registering $ALICE ==="
ALICE_RESPONSE=$(curl -s -X POST "$RELAY_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ALICE\",\"password\":\"SecurePass123!\",\"deviceFingerprint\":\"$ALICE-device-1\",\"deviceName\":\"Alice Laptop\"}")
echo "$ALICE_RESPONSE" | jq .
ALICE_TOKEN=$(echo "$ALICE_RESPONSE" | jq -r '.token')
ALICE_ID=$(echo "$ALICE_RESPONSE" | jq -r '.userId')

echo ""
echo "=== Registering $BOB ==="
BOB_RESPONSE=$(curl -s -X POST "$RELAY_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$BOB\",\"password\":\"SecurePass123!\",\"deviceFingerprint\":\"$BOB-device-1\",\"deviceName\":\"Bob Desktop\"}")
echo "$BOB_RESPONSE" | jq .
BOB_TOKEN=$(echo "$BOB_RESPONSE" | jq -r '.token')
BOB_ID=$(echo "$BOB_RESPONSE" | jq -r '.userId')

echo ""
echo "=== $ALICE adds $BOB as contact ==="
curl -s -X POST "$RELAY_URL/api/contacts" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$BOB\"}" | jq .

echo ""
echo "=== $BOB adds $ALICE as contact (now mutual) ==="
curl -s -X POST "$RELAY_URL/api/contacts" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ALICE\"}" | jq .

echo ""
echo "=== $ALICE lists contacts (should include $BOB) ==="
curl -s -X GET "$RELAY_URL/api/contacts" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq .

echo ""
echo "=== $ALICE sends $BOB a DM over the WebSocket ==="
node - "$WS_URL" "$ALICE_TOKEN" "$BOB_ID" <<'EOF'
const [wsUrl, token, recipientId] = process.argv.slice(2);
const WebSocket = require('ws');
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => { console.error('Timed out waiting for the relay'); process.exit(1); }, 5000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', payload: { token, deviceFingerprint: 'smoke-script' } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'auth_response') {
    if (!msg.payload.success) { console.error('WS auth failed:', msg.payload.error); process.exit(1); }
    ws.send(JSON.stringify({ type: 'message', payload: { recipientId, content: 'Hello from the smoke test!' } }));
  } else if (msg.type === 'message_sent') {
    console.log('DM accepted by relay, id:', msg.payload.message?.id ?? '(ok)');
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  } else if (msg.type === 'error') {
    console.error('Relay error:', JSON.stringify(msg.payload));
    clearTimeout(timer);
    process.exit(1);
  }
});
ws.on('error', (err) => { console.error('WebSocket error:', err.message); clearTimeout(timer); process.exit(1); });
EOF

echo ""
echo "=== Smoke test complete ==="
echo "Alice ($ALICE) id=$ALICE_ID"
echo "Bob   ($BOB) id=$BOB_ID"
