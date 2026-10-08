import WebSocket from 'ws';

const RELAY_URL = 'http://localhost:5000';
const WS_URL = 'ws://localhost:5000/ws';

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${RELAY_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return res.json();
}

async function register(username) {
  console.log(`[REST] Registering ${username}...`);
  return await post('/api/auth/register', {
    username,
    password: 'Password1!',
    deviceFingerprint: `dev-${username}`
  });
}

function connectWs(username, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      console.log(`[WS] ${username} connected to relay`);
      ws.send(JSON.stringify({ 
        type: 'auth', 
        payload: { token, deviceFingerprint: `dev-${username}` } 
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_response') {
        if (msg.payload.success) {
          console.log(`[WS] ${username} authenticated successfully`);
          resolve(ws);
        } else {
          console.error(`[WS] ${username} auth failed:`, msg.payload.error);
          reject(new Error(msg.payload.error));
        }
      } else if (msg.type === 'message') {
        console.log(`\n💬 [MESSAGE RECEIVED BY ${username.toUpperCase()}]`);
        console.log(`From: ${msg.payload.message.senderUsername}`);
        console.log(`Content: "${msg.payload.message.content}"`);
      }
    });
  });
}

async function main() {
  const ts = Date.now();
  const aliceName = `alice_${ts}`;
  const bobName = `bob_${ts}`;
  
  // 1. Register users
  const alice = await register(aliceName);
  const bob = await register(bobName);
  
  // 2. Add contacts
  console.log(`\n[REST] ${aliceName} adding ${bobName} as contact...`);
  await post('/api/contacts', { username: bobName }, alice.token);
  
  console.log(`[REST] ${bobName} adding ${aliceName} as contact...`);
  await post('/api/contacts', { username: aliceName }, bob.token);
  
  // 3. Connect WebSockets
  console.log('\n[WS] Connecting WebSocket clients...');
  const aliceWs = await connectWs(aliceName, alice.token);
  const bobWs = await connectWs(bobName, bob.token);
  
  // 4. Send messages
  console.log(`\n[WS] ${aliceName} is typing a message to ${bobName}...`);
  aliceWs.send(JSON.stringify({
    type: 'message',
    payload: {
      recipientId: bob.userId,
      content: 'Hello Bob! This is Alice from the automated test script.',
      isEphemeral: false,
      clientMessageId: 'msg-1'
    }
  }));
  
  await new Promise(r => setTimeout(r, 1000));
  
  console.log(`\n[WS] ${bobName} is typing a reply to ${aliceName}...`);
  bobWs.send(JSON.stringify({
    type: 'message',
    payload: {
      recipientId: alice.userId,
      content: 'Hi Alice! I received your message loud and clear.',
      isEphemeral: false,
      clientMessageId: 'msg-2'
    }
  }));
  
  await new Promise(r => setTimeout(r, 1500));
  
  console.log('\n✅ Chat simulation completed successfully!');
  aliceWs.close();
  bobWs.close();
}

main().catch(console.error);
