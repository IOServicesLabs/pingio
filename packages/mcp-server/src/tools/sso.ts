import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import { p2pService } from '../services/p2p.js';
import * as authClient from '../services/auth-client.js';
import { syncContacts } from './auth.js';

export async function listSsoProviders(): Promise<ToolResult> {
  const result = await authClient.listSsoProviders();

  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
  }

  if (!result.providers || result.providers.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No enterprise SSO providers are configured on this auth server.\n\nUse login with a username and password instead.',
      }],
    };
  }

  const lines = result.providers.map(p => `- ${p.slug} — ${p.name}`);
  return {
    content: [{
      type: 'text',
      text: `Available SSO providers:\n${lines.join('\n')}\n\nRun login_sso(provider="<slug>") to sign in with one.`,
    }],
  };
}

export async function loginSso(slug?: string): Promise<ToolResult> {
  if (!slug) {
    return listSsoProviders();
  }

  try {
    const result = await authClient.startSsoLogin(slug);

    if (!result.success || !result.authorizeUrl) {
      return {
        content: [{ type: 'text', text: `SSO login failed: ${result.error || 'no authorize URL returned'}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: [
          `SSO login started for "${slug}".`,
          '',
          'Open this URL in your browser to authenticate with your identity provider:',
          result.authorizeUrl,
          '',
          'After signing in, the browser will show a one-time code (valid for about 5 minutes). Then run:',
          'complete_sso_login(code="XXXX-XXXX-XXXX")',
        ].join('\n'),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `SSO login failed: ${(error as Error).message}` }], isError: true };
  }
}

export async function completeSsoLogin(code: string): Promise<ToolResult> {
  if (!code || !code.trim()) {
    return { content: [{ type: 'text', text: 'Error: code is required' }], isError: true };
  }

  try {
    const result = await authClient.completeSsoLogin(code.trim());

    if (!result.success || !result.token || !result.userId) {
      return {
        content: [{ type: 'text', text: `SSO login failed: ${result.error || 'incomplete response from server'}` }],
        isError: true,
      };
    }

    const username = result.username || result.user?.username;
    if (!username) {
      return {
        content: [{ type: 'text', text: 'SSO login failed: server returned no username' }],
        isError: true,
      };
    }

    // Discover relay URL from auth service when in cloud/auto mode
    await configManager.discoverRelayUrl();

    configManager.setIdentity(username, result.token, result.userId, result.refreshToken, result.deviceId);

    relayClient.connect(result.token);

    await p2pService.initialize(result.userId, username);

    await syncContacts();

    return {
      content: [{
        type: 'text',
        text: `Successfully logged in via SSO as "${username}"!\n\nYour contacts and messages will sync automatically.`,
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `SSO login failed: ${(error as Error).message}` }], isError: true };
  }
}
