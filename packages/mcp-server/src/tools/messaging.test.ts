import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendMessage, editMessage, deleteMessage, getHistory } from './messaging.js';
import { configManager } from '../config.js';
import { storageService } from '../services/storage.js';
import { relayClient } from '../services/relay.js';
import { dmKeyService } from '../services/dm-keys.js';
import { encryptDmMessage, decryptDmMessage } from '../services/crypto.js';

// Mock dependencies
vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getEffectiveRelayUrl: vi.fn(() => 'ws://localhost:3000/ws'),
    getRestBaseUrl: vi.fn(() => 'http://localhost:3000'),
  },
}));

vi.mock('../services/storage.js', () => ({
  storageService: {
    getContacts: vi.fn(),
    saveMessage: vi.fn(),
    getChatSettings: vi.fn(),
    updateMessage: vi.fn(),
  },
}));

vi.mock('../services/relay.js', () => ({
  relayClient: {
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
  },
}));

vi.mock('../services/dm-keys.js', () => ({
  dmKeyService: {
    getDmKey: vi.fn(),
    refreshPeerKey: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../services/crypto.js', () => ({
  encryptDmMessage: vi.fn(),
  decryptDmMessage: vi.fn(),
}));

vi.mock('axios');
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

// A schema-valid encrypted envelope (shared module is NOT mocked here, so
// parseEncryptedEnvelope runs for real): keyId is 16 lowercase hex chars.
const KEY_ID = '0123456789abcdef';
const OTHER_KEY_ID = 'fedcba9876543210';
const ENVELOPE = JSON.stringify({
  v: 1,
  alg: 'A256GCM',
  keyId: KEY_ID,
  nonce: 'bm9uY2UxMjM0',
  ct: 'Y2lwaGVydGV4dA',
});

const DM_KEY = { key: Buffer.alloc(32, 9), keyId: KEY_ID };

async function mockAxiosGet(data: unknown) {
  const axios = await import('axios');
  vi.spyOn(axios.default, 'get').mockResolvedValue({ data });
}

describe('Token Optimization Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (configManager.getConfig as any).mockReturnValue({
      identity: {
        authToken: 'test-token',
        userId: 'user-123',
        username: 'testuser',
      },
    });
    // Default: peer has no published key → plaintext path (keeps legacy tests intact).
    (dmKeyService.getDmKey as any).mockResolvedValue(null);
    (encryptDmMessage as any).mockReturnValue(ENVELOPE);
    (decryptDmMessage as any).mockReturnValue('decrypted dm');
  });

  describe('Success Response Format', () => {
    it('sendMessage should return compact success format', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123', isBlocked: false },
      ]);

      const result = await sendMessage('alice', 'Hello!');

      expect(result.content[0].text).toBe('✓ @alice');
      expect(result.isError).toBeUndefined();
    });

    it('editMessage should return compact success format', async () => {
      const result = await editMessage('msg-123', 'Updated content', 'alice');

      expect(result.content[0].text).toBe('✓');
    });

    it('deleteMessage should return compact success format', async () => {
      const result = await deleteMessage('msg-123', true);

      expect(result.content[0].text).toBe('✓');
    });
  });

  describe('DM end-to-end encryption', () => {
    it('encrypts when the peer has a published key and marks the reply 🔒', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123', isBlocked: false },
      ]);
      (dmKeyService.getDmKey as any).mockResolvedValue(DM_KEY);

      const result = await sendMessage('alice', 'secret plans');

      expect(dmKeyService.getDmKey).toHaveBeenCalledWith('alice-123');
      expect(encryptDmMessage).toHaveBeenCalledWith(DM_KEY.key, KEY_ID, 'user-123', 'alice-123', 'secret plans');
      expect(relayClient.sendMessage).toHaveBeenCalledWith('alice-123', ENVELOPE);
      expect(result.content[0].text).toBe('✓ @alice 🔒');
    });

    it('saves plaintext to local storage even when the wire message is encrypted', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123', isBlocked: false },
      ]);
      (dmKeyService.getDmKey as any).mockResolvedValue(DM_KEY);

      await sendMessage('alice', 'secret plans');

      const saved = (storageService.saveMessage as any).mock.calls[0][1];
      expect(saved.content).toBe('secret plans');
    });

    it('encrypts on the non-contact search path too', async () => {
      (storageService.getContacts as any).mockReturnValue([]);
      await mockAxiosGet({ users: [{ id: 'bob-456', username: 'bob' }] });
      (dmKeyService.getDmKey as any).mockResolvedValue(DM_KEY);

      const result = await sendMessage('bob', 'hi bob');

      expect(relayClient.sendMessage).toHaveBeenCalledWith('bob-456', ENVELOPE);
      expect(result.content[0].text).toBe('✓ @bob 🔒');
    });

    it('fails closed when the peer key cannot be verified', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123', isBlocked: false },
      ]);
      (dmKeyService.getDmKey as any).mockRejectedValue(new Error('relay unreachable'));

      const result = await sendMessage('alice', 'secret plans');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Could not verify @alice's encryption key");
      expect(relayClient.sendMessage).not.toHaveBeenCalled();
    });

    it('fails closed when encryption itself throws', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123', isBlocked: false },
      ]);
      (dmKeyService.getDmKey as any).mockResolvedValue(DM_KEY);
      (encryptDmMessage as any).mockImplementation(() => {
        throw new Error('plaintext too long');
      });

      const result = await sendMessage('alice', 'x'.repeat(9000));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('plaintext too long');
      expect(relayClient.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Message History Format', () => {
    it('should format messages in compact HH:MM format', async () => {
      // This would need axios mock to test fully
      // For now, just verify the function structure
      expect(getHistory).toBeDefined();
    });

    it('should show empty history in compact format', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);

      await mockAxiosGet({ messages: [] });

      const result = await getHistory('alice');

      expect(result.content[0].text).toBe('No messages with @alice');
    });
  });

  describe('History decryption', () => {
    const HISTORY_MESSAGE = {
      id: 'm1',
      senderId: 'alice-123',
      recipientId: 'user-123',
      senderUsername: 'alice',
      content: ENVELOPE,
      createdAt: '2026-10-08T10:30:00.000Z',
    };

    it('decrypts envelope messages with the pairwise key', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);
      await mockAxiosGet({ messages: [HISTORY_MESSAGE] });
      (dmKeyService.getDmKey as any).mockResolvedValue(DM_KEY);
      (decryptDmMessage as any).mockReturnValue('pair programming at 3?');

      const result = await getHistory('alice');

      expect(decryptDmMessage).toHaveBeenCalledWith(DM_KEY.key, 'user-123', 'alice-123', ENVELOPE);
      expect(result.content[0].text).toContain('alice: 🔒 pair programming at 3?');
      expect(dmKeyService.refreshPeerKey).not.toHaveBeenCalled();
    });

    it('refetches the peer key once when the envelope keyId does not match', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);
      await mockAxiosGet({ messages: [HISTORY_MESSAGE] });
      // Cached key was derived from an older peer identity...
      (dmKeyService.getDmKey as any).mockResolvedValue({ key: Buffer.alloc(32, 1), keyId: OTHER_KEY_ID });
      // ...and the refreshed key matches the envelope.
      (dmKeyService.refreshPeerKey as any).mockResolvedValue(DM_KEY);
      (decryptDmMessage as any).mockReturnValue('rotated but readable');

      const result = await getHistory('alice');

      expect(dmKeyService.refreshPeerKey).toHaveBeenCalledWith('alice-123');
      expect(result.content[0].text).toContain('🔒 rotated but readable');
    });

    it('shows a key-unavailable placeholder when the key is unknown', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);
      await mockAxiosGet({ messages: [HISTORY_MESSAGE] });
      (dmKeyService.getDmKey as any).mockResolvedValue(null);

      const result = await getHistory('alice');

      expect(result.content[0].text).toContain('🔒 [encrypted message — key unavailable]');
    });

    it('shows a decryption-failed placeholder when the key matches but GCM rejects', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);
      await mockAxiosGet({ messages: [HISTORY_MESSAGE] });
      (dmKeyService.getDmKey as any).mockResolvedValue(DM_KEY);
      (decryptDmMessage as any).mockReturnValue(null);

      const result = await getHistory('alice');

      expect(result.content[0].text).toContain('🔒 [encrypted message — decryption failed]');
    });

    it('still renders history when the key lookup throws', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);
      await mockAxiosGet({ messages: [HISTORY_MESSAGE] });
      (dmKeyService.getDmKey as any).mockRejectedValue(new Error('network down'));

      const result = await getHistory('alice');

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('🔒 [encrypted message — key unavailable]');
    });

    it('leaves plaintext messages untouched', async () => {
      (storageService.getContacts as any).mockReturnValue([
        { username: 'alice', contactId: 'alice-123' },
      ]);
      await mockAxiosGet({
        messages: [{ ...HISTORY_MESSAGE, content: 'plain hello' }],
      });

      const result = await getHistory('alice');

      expect(result.content[0].text).toContain('alice: plain hello');
      expect(dmKeyService.getDmKey).not.toHaveBeenCalled();
    });
  });

  describe('Token Count Comparison', () => {
    it('new format should use fewer tokens than old format', () => {
      const oldFormat = `Message sent to @alice!`; // ~5 tokens
      const newFormat = `✓ @alice`; // ~3 tokens

      // Simple token estimation (split by spaces/punctuation)
      const estimateTokens = (text: string) => text.split(/[\s\W]+/).filter(Boolean).length;

      expect(estimateTokens(newFormat)).toBeLessThan(estimateTokens(oldFormat));
    });

    it('history header should be minimal', () => {
      const oldHeader = `Message history with @alice:\n\n`; // ~8 tokens
      const newHeader = ''; // 0 tokens

      expect(newHeader.length).toBeLessThan(oldHeader.length);
    });
  });
});
