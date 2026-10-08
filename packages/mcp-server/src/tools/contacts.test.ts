import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    saveContact: vi.fn(),
    removeContact: vi.fn(),
  },
}));

const mockAxiosPost = vi.fn();
const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
    isAxiosError: vi.fn((e: any) => e?.isAxiosError === true),
  },
}));

describe('Contacts tools', () => {
  let configManager: any;
  let storageService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configMod = await import('../config.js');
    configManager = configMod.configManager;
    const storageMod = await import('../services/storage.js');
    storageService = storageMod.storageService;

    configManager.getConfig.mockReturnValue({
      identity: { authToken: 'test-token', userId: 'u1', username: 'alice' },
    });
  });

  describe('addContact', () => {
    it('calls POST /api/contacts and saves locally', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { contact: { userId: 'u1', contactId: 'u2', username: 'bob' } },
      });

      const { addContact } = await import('./contacts.js');
      const result = await addContact('bob');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/contacts',
        expect.objectContaining({ username: 'bob' }),
        expect.any(Object)
      );
      expect(storageService.saveContact).toHaveBeenCalled();
      expect(result.content[0].text).toBe('✓ @bob');
    });

    it('returns error when not logged in', async () => {
      configManager.getConfig.mockReturnValue({ identity: { authToken: null } });

      const { addContact } = await import('./contacts.js');
      const result = await addContact('bob');

      expect(result.isError).toBe(true);
    });
  });

  describe('removeContact', () => {
    it('removes contact from local storage', async () => {
      storageService.getContacts.mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 },
      ]);
      storageService.removeContact.mockReturnValue(true);

      const { removeContact } = await import('./contacts.js');
      const result = await removeContact('bob');

      expect(storageService.removeContact).toHaveBeenCalledWith('u2');
      expect(result.content[0].text).toContain('bob');
    });

    it('returns error when contact not found', async () => {
      storageService.getContacts.mockReturnValue([]);

      const { removeContact } = await import('./contacts.js');
      const result = await removeContact('nobody');

      expect(result.isError).toBe(true);
    });
  });

  describe('blockContact', () => {
    it('calls POST /api/contacts/:id/block AND updates local storage', async () => {
      const contact = { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 };
      storageService.getContacts.mockReturnValue([contact]);
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { blockContact } = await import('./contacts.js');
      const result = await blockContact('bob', true);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/contacts/u2/block',
        {},
        expect.any(Object)
      );
      expect(storageService.saveContact).toHaveBeenCalledWith(
        expect.objectContaining({ isBlocked: true })
      );
      expect(result.content[0].text).toContain('blocked');
    });

    it('calls POST /api/contacts/:id/unblock when block=false', async () => {
      const contact = { username: 'bob', contactId: 'u2', isBlocked: true, unreadCount: 0 };
      storageService.getContacts.mockReturnValue([contact]);
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { blockContact } = await import('./contacts.js');
      const result = await blockContact('bob', false);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/contacts/u2/unblock',
        {},
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('unblocked');
    });

    it('returns error when contact not found', async () => {
      storageService.getContacts.mockReturnValue([]);

      const { blockContact } = await import('./contacts.js');
      const result = await blockContact('nobody');

      expect(result.isError).toBe(true);
    });
  });

  describe('searchUsers', () => {
    it('calls GET /api/users/search and returns results', async () => {
      mockAxiosGet.mockResolvedValue({
        data: { users: [{ username: 'alice' }, { username: 'alan' }] },
      });

      const { searchUsers } = await import('./contacts.js');
      const result = await searchUsers('al');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/users/search?q=al',
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('alice');
    });

    it('returns no users found when empty', async () => {
      mockAxiosGet.mockResolvedValue({ data: { users: [] } });

      const { searchUsers } = await import('./contacts.js');
      const result = await searchUsers('xyz');

      expect(result.content[0].text).toContain('No users found');
    });
  });
});
