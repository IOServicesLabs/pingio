import axios from 'axios';
import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import { storageService } from '../services/storage.js';
import { PRESENCE_STATUSES, type Presence } from '@pingio/shared';

export async function setStatus(
  status: Presence['status'],
  message?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Validate status
  if (!PRESENCE_STATUSES.includes(status)) {
    return {
      content: [{
        type: 'text',
        text: `Invalid status. Must be one of: ${PRESENCE_STATUSES.join(', ')}`,
      }],
      isError: true,
    };
  }

  relayClient.updatePresence(status, message);

  const statusMsg = message ? ` with status: "${message}"` : '';

  return {
    content: [{
      type: 'text',
      text: `Status set to ${status}${statusMsg}.`,
    }],
  };
}

// Presence is contacts-scoped on the relay (mutual contacts only), so the
// lookup resolves the username through the local contact list first.
export async function getUserStatus(username: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const contacts = storageService.getContacts();
  const contact = contacts.find(c => c.username === username);
  if (!contact) {
    return {
      content: [{ type: 'text', text: `Contact "${username}" not found. Presence is only visible between mutual contacts — add them first.` }],
      isError: true,
    };
  }

  const relayUrl = configManager.getRestBaseUrl();
  try {
    const response = await axios.get(`${relayUrl}/api/users/${contact.contactId}/presence`, {
      headers: { Authorization: `Bearer ${config.identity.authToken}` },
    });
    const presence = response.data.presence as Presence | null;
    const status = presence?.status ?? 'offline';
    const custom = presence?.message ? ` — "${presence.message}"` : '';
    const seen = presence?.lastSeen ? ` (last seen ${new Date(presence.lastSeen).toLocaleString()})` : '';
    return { content: [{ type: 'text', text: `@${username} is ${status}${custom}${seen}` }] };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to get status: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to get status: ${(error as Error).message}` }], isError: true };
  }
}

export async function typing(recipient: string, isTyping: boolean = true): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Find contact
  const contacts = storageService.getContacts();
  const contact = contacts.find(c => c.username === recipient);

  if (!contact) {
    return { content: [{ type: 'text', text: `Contact "${recipient}" not found.` }], isError: true };
  }

  relayClient.sendTyping(contact.contactId, isTyping);

  return {
    content: [{
      type: 'text',
      text: isTyping ? `Typing indicator sent to @${recipient}.` : `Stopped typing indicator.`,
    }],
  };
}
