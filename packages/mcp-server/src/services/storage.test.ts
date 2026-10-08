import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises and fs before importing storage
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

describe('StorageService', () => {
  let storage: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Re-import to get fresh instance each time
    const mod = await import('./storage.js');
    storage = new mod.StorageService();
  });

  describe('saveContact / getContacts / removeContact', () => {
    it('saveContact stores contact and getContacts returns it', () => {
      const contact = {
        userId: 'u1',
        contactId: 'u2',
        username: 'bob',
        isBlocked: false,
        unreadCount: 0,
        createdAt: new Date(),
      };

      storage.saveContact(contact);
      const contacts = storage.getContacts();

      expect(contacts).toHaveLength(1);
      expect(contacts[0].username).toBe('bob');
    });

    it('removeContact removes the contact', () => {
      const contact = {
        userId: 'u1',
        contactId: 'u2',
        username: 'bob',
        isBlocked: false,
        unreadCount: 0,
        createdAt: new Date(),
      };

      storage.saveContact(contact);
      storage.removeContact('u2');

      expect(storage.getContacts()).toHaveLength(0);
    });

    it('removeContact returns false for missing contact', () => {
      const result = storage.removeContact('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('saveMessage / getMessages', () => {
    it('saveMessage saves and getMessages retrieves by chatId', () => {
      const message = {
        id: 'msg-1',
        senderId: 'u1',
        senderUsername: 'alice',
        recipientId: 'u2',
        content: 'Hello',
        isEphemeral: false,
        createdAt: new Date(),
        isDelivered: false,
      };

      storage.saveMessage('chat-1', message);
      const messages = storage.getMessages('chat-1');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
    });

    it('getMessages returns empty array for unknown chatId', () => {
      const messages = storage.getMessages('unknown');
      expect(messages).toHaveLength(0);
    });

    it('clearMessages removes messages for a specific chat only', () => {
      const msg1 = { id: 'msg-1', senderId: 'u1', senderUsername: 'alice', recipientId: 'u2', content: 'Hi', isEphemeral: false, createdAt: new Date(), isDelivered: false };
      const msg2 = { id: 'msg-2', senderId: 'u2', senderUsername: 'bob', recipientId: 'u1', content: 'Hey', isEphemeral: false, createdAt: new Date(), isDelivered: false };
      storage.saveMessage('chat-1', msg1);
      storage.saveMessage('chat-2', msg2);

      storage.clearMessages('chat-1');

      expect(storage.getMessages('chat-1')).toHaveLength(0);
      expect(storage.getMessages('chat-2')).toHaveLength(1);
    });

    it('clearMessages removes all messages', () => {
      const msg = { id: 'msg-1', senderId: 'u1', senderUsername: 'alice', recipientId: 'u2', content: 'Hi', isEphemeral: false, createdAt: new Date(), isDelivered: false };
      storage.saveMessage('chat-1', msg);
      storage.clearAll();

      expect(storage.getMessages('chat-1')).toHaveLength(0);
    });
  });

  describe('getChatSettings / setChatSettings', () => {
    it('setChatSettings saves and getChatSettings retrieves', () => {
      storage.setChatSettings({ chatId: 'chat-1', chatType: 'dm', isEphemeral: true, muteNotifications: false });
      const settings = storage.getChatSettings('chat-1');

      expect(settings?.isEphemeral).toBe(true);
    });

    it('getChatSettings returns undefined for unknown chatId', () => {
      expect(storage.getChatSettings('unknown')).toBeUndefined();
    });
  });
});
