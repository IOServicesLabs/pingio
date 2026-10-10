import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ws module before importing RelayClient
const mockWsSend = vi.fn();
const mockWsClose = vi.fn();
const mockWsOn = vi.fn();
let wsReadyState = 1;

const MockWebSocket = vi.fn().mockImplementation(() => ({
  send: mockWsSend,
  close: mockWsClose,
  on: mockWsOn,
  get readyState() { return wsReadyState; },
}));
(MockWebSocket as any).OPEN = 1;

vi.mock('ws', () => ({ default: MockWebSocket }));

vi.mock('../config.js', () => ({
  configManager: {
    getEffectiveRelayUrl: vi.fn(() => 'ws://localhost:3000/ws'),
    getRelayPool: vi.fn(() => ['ws://localhost:3000/ws', 'wss://relay-b.example.com/ws']),
    getConfig: vi.fn(() => ({ identity: { authToken: 'test-token', userId: 'u1', username: 'alice' } })),
  },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));

describe('RelayClient', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    wsReadyState = 1;
    // Re-import to get fresh module
    vi.resetModules();
  });

  it('connect() creates WS and sends auth message on open', async () => {
    const { RelayClient } = await import('./relay.js');
    const client = new RelayClient();

    let openHandler: Function | undefined;
    mockWsOn.mockImplementation((event: string, cb: Function) => {
      if (event === 'open') openHandler = cb;
    });

    client.connect('test-token', 'fp-1');
    expect(MockWebSocket).toHaveBeenCalledWith('ws://localhost:3000/ws');

    // Simulate open event
    openHandler?.();

    expect(mockWsSend).toHaveBeenCalledWith(
      expect.stringContaining('"type":"auth"')
    );
    const sentMsg = JSON.parse(mockWsSend.mock.calls[0][0]);
    expect(sentMsg.payload.token).toBe('test-token');
  });

  it('sendMessage() sends message over WS when connected', async () => {
    const { RelayClient } = await import('./relay.js');
    const client = new RelayClient();

    let openHandler: Function | undefined;
    mockWsOn.mockImplementation((event: string, cb: Function) => {
      if (event === 'open') openHandler = cb;
    });

    client.connect('test-token');
    openHandler?.();

    mockWsSend.mockClear();
    client.sendMessage('u2', 'Hello!');

    expect(mockWsSend).toHaveBeenCalledWith(
      expect.stringContaining('"type":"message"')
    );
    const sent = JSON.parse(mockWsSend.mock.calls[0][0]);
    expect(sent.payload.recipientId).toBe('u2');
    expect(sent.payload.content).toBe('Hello!');
  });

  it('sendMessage() queues message when not connected', async () => {
    wsReadyState = 3; // CLOSED
    const { RelayClient } = await import('./relay.js');
    const client = new RelayClient();

    mockWsOn.mockImplementation(() => {});
    client.connect('test-token');

    client.sendMessage('u2', 'Queued message');

    // Message should NOT be sent immediately (socket not open)
    expect(mockWsSend).not.toHaveBeenCalledWith(
      expect.stringContaining('"type":"message"')
    );
  });

  it('handleIncomingMessage routes message type to event', async () => {
    const { RelayClient } = await import('./relay.js');
    const client = new RelayClient();

    let messageHandler: Function | undefined;
    let openHandler: Function | undefined;

    mockWsOn.mockImplementation((event: string, cb: Function) => {
      if (event === 'message') messageHandler = cb;
      if (event === 'open') openHandler = cb;
    });

    client.connect('test-token');
    openHandler?.();

    const receivedMessages: any[] = [];
    client.on('message:received', (msg: any) => receivedMessages.push(msg));

    // Simulate incoming message
    const incoming = {
      id: 'id-1',
      type: 'message',
      timestamp: Date.now(),
      payload: { message: { id: 'msg-1', content: 'Hello', senderId: 'u2' } },
    };
    messageHandler?.(JSON.stringify(incoming));

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].content).toBe('Hello');
  });

  it('getStatus() returns current connection status', async () => {
    const { RelayClient } = await import('./relay.js');
    const client = new RelayClient();

    expect(client.getStatus()).toBe('disconnected');

    mockWsOn.mockImplementation(() => {});
    client.connect('test-token');

    expect(client.getStatus()).toBe('connecting');
  });

  it('disconnect() sets status to disconnected', async () => {
    const { RelayClient } = await import('./relay.js');
    const client = new RelayClient();

    mockWsOn.mockImplementation(() => {});
    client.connect('test-token');
    client.disconnect();

    expect(client.getStatus()).toBe('disconnected');
  });

  it('fails over to the next pool relay after a connection error', async () => {
    vi.useFakeTimers();
    try {
      const { RelayClient } = await import('./relay.js');
      const client = new RelayClient();

      let errorHandler: Function | undefined;
      mockWsOn.mockImplementation((event: string, cb: Function) => {
        if (event === 'error') errorHandler = cb;
      });

      client.connect('test-token');
      expect(MockWebSocket).toHaveBeenLastCalledWith('ws://localhost:3000/ws');

      // First relay errors — reconnect should target the second pool member.
      client.on('error', () => {}); // swallow emitted error
      wsReadyState = 3; // errored socket is closed
      errorHandler?.(new Error('connection refused'));
      vi.advanceTimersByTime(5000); // RECONNECT_INTERVAL

      expect(MockWebSocket).toHaveBeenLastCalledWith('wss://relay-b.example.com/ws');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails over immediately when a relay closes with 1013 (decommissioned)', async () => {
    vi.useFakeTimers();
    try {
      const { RelayClient } = await import('./relay.js');
      const client = new RelayClient();

      let closeHandler: Function | undefined;
      mockWsOn.mockImplementation((event: string, cb: Function) => {
        if (event === 'close') closeHandler = cb;
      });

      client.connect('test-token');
      expect(MockWebSocket).toHaveBeenLastCalledWith('ws://localhost:3000/ws');

      wsReadyState = 3; // closed socket
      closeHandler?.(1013, Buffer.from('relay node decommissioned'));
      vi.advanceTimersByTime(5000); // RECONNECT_INTERVAL

      expect(MockWebSocket).toHaveBeenLastCalledWith('wss://relay-b.example.com/ws');
    } finally {
      vi.useRealTimers();
    }
  });
});
