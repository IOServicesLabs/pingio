import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import { p2pService } from '../services/p2p.js';
import { storageService } from '../services/storage.js';
import { getDeviceFingerprint, getDeviceName } from './devices.js';
import * as authClient from '../services/auth-client.js';
import { validateUsername, validatePassword } from '@pingio/shared';

export async function registerUser(
  username: string,
  password: string,
  displayName?: string
): Promise<ToolResult> {
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    return { content: [{ type: 'text', text: `Error: ${usernameValidation.error}` }], isError: true };
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    return { content: [{ type: 'text', text: `Error: ${passwordValidation.error}` }], isError: true };
  }

  try {
    const result = await authClient.registerUser(username, password, displayName);

    if (!result.success) {
      let message = `Registration failed: ${result.error}`;
      if (result.suggestions && result.suggestions.length > 0) {
        message += `\n\nThat username is taken. Try one of these suggestions:\n${result.suggestions.map(s => `- ${s}`).join('\n')}`;
      }
      return { content: [{ type: 'text', text: message }], isError: true };
    }

    const { userId, token, refreshToken, deviceId } = result;
    if (!token || !userId) {
      return { content: [{ type: 'text', text: 'Registration failed: server returned incomplete response' }], isError: true };
    }

    // Discover relay URL from auth service when in cloud/auto mode
    await configManager.discoverRelayUrl();

    configManager.setIdentity(username, token, userId, refreshToken, deviceId);

    // Pass the device fingerprint like login does — relays with
    // DEVICE_VERIFICATION_REQUIRED=true reject fingerprint-less WS auth.
    relayClient.connect(token, getDeviceFingerprint());

    await p2pService.initialize(userId, username);

    return {
      content: [{
        type: 'text',
        text: `Successfully registered as "${username}"!\n\nYou can now:\n- Add contacts with add_contact\n- Send messages with send_message\n- Create or join channels`,
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Registration failed: ${(error as Error).message}` }], isError: true };
  }
}

export async function login(username: string, password: string): Promise<ToolResult> {
  try {
    const result = await authClient.login(username, password);

    if (result.verificationRequired) {
      return {
        content: [{
          type: 'text',
          text: `Login from new device detected.\n\nDevice ID: ${result.deviceId}\n\nTo verify this device, run the following from a trusted device where you're already logged in:\n\nverify_device(deviceId="${result.deviceId}")\n\nAfter verification, try logging in again.`,
        }],
        isError: true,
      };
    }

    if (!result.success) {
      return { content: [{ type: 'text', text: `Login failed: ${result.error}` }], isError: true };
    }

    // Cloud auth returns a bare userId; self-hosted relays return a user
    // object. Accept either so login works against both (and older servers).
    const user = result.user ?? (result.userId ? { id: result.userId, username } : undefined);
    const { token, refreshToken, deviceId } = result;
    if (!token || !user) {
      return { content: [{ type: 'text', text: 'Login failed: server returned incomplete response' }], isError: true };
    }

    // Discover relay URL from auth service when in cloud/auto mode
    await configManager.discoverRelayUrl();

    const deviceFingerprint = getDeviceFingerprint();
    configManager.setIdentity(user.username, token, user.id, refreshToken, deviceId);

    relayClient.connect(token, deviceFingerprint);

    await p2pService.initialize(user.id, user.username);

    await syncContacts();

    return {
      content: [{
        type: 'text',
        text: `Successfully logged in as "${user.username}"!\n\nYour contacts and messages will sync automatically.`,
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Login failed: ${(error as Error).message}` }], isError: true };
  }
}

export async function logout(): Promise<ToolResult> {
  relayClient.disconnect();

  p2pService.shutdown();

  configManager.clearIdentity();

  storageService.clearAll();

  return {
    content: [{
      type: 'text',
      text: 'Successfully logged out. All local data has been cleared.',
    }],
  };
}

export async function whoami(): Promise<ToolResult> {
  const config = configManager.getConfig();

  if (!config.identity.username) {
    return {
      content: [{
        type: 'text',
        text: 'You are not logged in.\n\nUse register_user or login to authenticate.',
      }],
    };
  }

  const connectionStatus = relayClient.getStatus();

  return {
    content: [{
      type: 'text',
      text: `Username: ${config.identity.username}\nUser ID: ${config.identity.userId || 'N/A'}\nMode: ${config.mode}\nConnection: ${connectionStatus}\n\nRelay: ${configManager.getEffectiveRelayUrl()}`,
    }],
  };
}

export async function syncContacts(): Promise<void> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) return;

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const axios = (await import('axios')).default;
    const response = await axios.get(`${relayUrl}/api/contacts`, {
      headers: { Authorization: `Bearer ${config.identity.authToken}` },
    });

    const { contacts } = response.data;
    for (const contact of contacts) {
      storageService.saveContact({
        ...contact,
        unreadCount: 0,
      });
    }
  } catch (error) {
    console.error('Failed to sync contacts:', error);
  }
}
