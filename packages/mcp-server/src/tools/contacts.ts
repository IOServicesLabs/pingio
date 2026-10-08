import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { storageService } from '../services/storage.js';
import axios from 'axios';

export async function addContact(username: string, customName?: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/contacts`,
      { username, customName },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { contact } = response.data;

    // Save to local storage
    storageService.saveContact({
      ...contact,
      unreadCount: 0,
    });

    return {
      content: [{ type: 'text', text: `✓ @${username}` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to add contact: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to add contact: ${(error as Error).message}` }], isError: true };
  }
}

export async function removeContact(username: string): Promise<ToolResult> {
  // Find contact by username
  const contacts = storageService.getContacts();
  const contact = contacts.find(c => c.username === username);

  if (!contact) {
    return { content: [{ type: 'text', text: `Contact "${username}" not found` }], isError: true };
  }

  storageService.removeContact(contact.contactId);

  return {
    content: [{ type: 'text', text: `✓ @${username} removed` }],
  };
}

export async function listContacts(): Promise<ToolResult> {
  const contacts = storageService.getContacts();

  if (contacts.length === 0) {
    return {
      content: [{ type: 'text', text: 'No contacts' }],
    };
  }

  const contactList = contacts.map(c => {
    const presence = c.presence ? ` ${c.presence.status}` : '';
    const unread = c.unreadCount > 0 ? ` ${c.unreadCount}` : '';
    return `${c.username}${presence}${unread}`;
  }).join('\n');

  return {
    content: [{ type: 'text', text: contactList }],
  };
}

export async function blockContact(username: string, block: boolean = true): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const contacts = storageService.getContacts();
  const contact = contacts.find(c => c.username === username);

  if (!contact) {
    return { content: [{ type: 'text', text: `Contact "${username}" not found` }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();
  const action = block ? 'block' : 'unblock';

  try {
    await axios.post(
      `${relayUrl}/api/contacts/${contact.contactId}/${action}`,
      {},
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to ${action} contact: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to ${action} contact: ${(error as Error).message}` }], isError: true };
  }

  contact.isBlocked = block;
  storageService.saveContact(contact);

  return {
    content: [{ type: 'text', text: `${block ? '✓ blocked' : '✓ unblocked'} @${username}` }],
  };
}

export async function searchUsers(query: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.get(`${relayUrl}/api/users/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${config.identity.authToken}` },
    });

    const { users } = response.data;

    if (users.length === 0) {
      return {
        content: [{ type: 'text', text: `No users found` }],
      };
    }

    const userList = users.map((u: { username: string }) => u.username).join(', ');

    return {
      content: [{ type: 'text', text: userList }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Search failed: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Search failed: ${(error as Error).message}` }], isError: true };
  }
}
