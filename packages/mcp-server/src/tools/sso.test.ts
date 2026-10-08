import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    discoverRelayUrl: vi.fn(async () => 'ws://localhost:3000/ws'),
    setIdentity: vi.fn(),
  },
}));

vi.mock('../services/relay.js', () => ({
  relayClient: { connect: vi.fn() },
}));

vi.mock('../services/p2p.js', () => ({
  p2pService: { initialize: vi.fn(async () => undefined) },
}));

vi.mock('../services/auth-client.js', () => ({
  listSsoProviders: vi.fn(),
  startSsoLogin: vi.fn(),
  completeSsoLogin: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  syncContacts: vi.fn(async () => undefined),
}));

describe('SSO tools', () => {
  let authClient: any;
  let configManager: any;
  let relayClient: any;
  let p2pService: any;
  let syncContacts: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    authClient = await import('../services/auth-client.js');
    ({ configManager } = await import('../config.js'));
    ({ relayClient } = await import('../services/relay.js'));
    ({ p2pService } = await import('../services/p2p.js'));
    ({ syncContacts } = await import('./auth.js'));
  });

  describe('listSsoProviders', () => {
    it('lists providers with slug and name', async () => {
      authClient.listSsoProviders.mockResolvedValue({
        success: true,
        providers: [
          { slug: 'acme', name: 'Acme Corp SSO' },
          { slug: 'globex', name: 'Globex Entra ID' },
        ],
      });

      const { listSsoProviders } = await import('./sso.js');
      const result = await listSsoProviders();

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('acme — Acme Corp SSO');
      expect(result.content[0].text).toContain('globex — Globex Entra ID');
      expect(result.content[0].text).toContain('login_sso(provider=');
    });

    it('reports when no providers are configured', async () => {
      authClient.listSsoProviders.mockResolvedValue({ success: true, providers: [] });

      const { listSsoProviders } = await import('./sso.js');
      const result = await listSsoProviders();

      expect(result.content[0].text).toContain('No enterprise SSO providers');
    });

    it('surfaces an error from the client', async () => {
      authClient.listSsoProviders.mockResolvedValue({ success: false, error: 'SSO login is only available in cloud mode' });

      const { listSsoProviders } = await import('./sso.js');
      const result = await listSsoProviders();

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('cloud mode');
    });
  });

  describe('loginSso', () => {
    it('lists providers when no slug is given', async () => {
      authClient.listSsoProviders.mockResolvedValue({
        success: true,
        providers: [{ slug: 'acme', name: 'Acme Corp SSO' }],
      });

      const { loginSso } = await import('./sso.js');
      const result = await loginSso();

      expect(authClient.startSsoLogin).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('acme');
    });

    it('returns the authorize URL and next-step instructions', async () => {
      authClient.startSsoLogin.mockResolvedValue({
        success: true,
        authorizeUrl: 'https://idp.acme.example/authorize?client_id=abc',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

      const { loginSso } = await import('./sso.js');
      const result = await loginSso('acme');

      expect(authClient.startSsoLogin).toHaveBeenCalledWith('acme');
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('https://idp.acme.example/authorize?client_id=abc');
      expect(result.content[0].text).toContain('complete_sso_login(code=');
    });

    it('surfaces a start failure', async () => {
      authClient.startSsoLogin.mockResolvedValue({ success: false, error: 'Unknown SSO provider: nope' });

      const { loginSso } = await import('./sso.js');
      const result = await loginSso('nope');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown SSO provider');
    });
  });

  describe('completeSsoLogin', () => {
    it('sets identity, connects the relay, and syncs contacts', async () => {
      authClient.completeSsoLogin.mockResolvedValue({
        success: true,
        userId: 'u1',
        username: 'alice',
        token: 'tok-1',
        refreshToken: 'rt-1',
        deviceId: 'd1',
      });

      const { completeSsoLogin } = await import('./sso.js');
      const result = await completeSsoLogin('ABCD-EFGH-JKMN');

      expect(result.isError).toBeUndefined();
      expect(authClient.completeSsoLogin).toHaveBeenCalledWith('ABCD-EFGH-JKMN');
      expect(configManager.discoverRelayUrl).toHaveBeenCalled();
      expect(configManager.setIdentity).toHaveBeenCalledWith('alice', 'tok-1', 'u1', 'rt-1', 'd1');
      expect(relayClient.connect).toHaveBeenCalledWith('tok-1');
      expect(p2pService.initialize).toHaveBeenCalledWith('u1', 'alice');
      expect(syncContacts).toHaveBeenCalled();
      expect(result.content[0].text).toContain('"alice"');
    });

    it('requires a code', async () => {
      const { completeSsoLogin } = await import('./sso.js');
      const result = await completeSsoLogin('   ');

      expect(result.isError).toBe(true);
      expect(authClient.completeSsoLogin).not.toHaveBeenCalled();
    });

    it('surfaces an invalid/expired code error', async () => {
      authClient.completeSsoLogin.mockResolvedValue({
        success: false,
        error: 'Login code is invalid, expired, or already used',
      });

      const { completeSsoLogin } = await import('./sso.js');
      const result = await completeSsoLogin('XXXX-XXXX-XXXX');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalid, expired, or already used');
      expect(configManager.setIdentity).not.toHaveBeenCalled();
    });

    it('fails when the response lacks a token', async () => {
      authClient.completeSsoLogin.mockResolvedValue({ success: true, userId: 'u1', username: 'alice' });

      const { completeSsoLogin } = await import('./sso.js');
      const result = await completeSsoLogin('ABCD-EFGH-JKMN');

      expect(result.isError).toBe(true);
      expect(configManager.setIdentity).not.toHaveBeenCalled();
    });
  });
});
