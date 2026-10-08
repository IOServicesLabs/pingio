import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import { storageService } from '../services/storage.js';
import { p2pService } from '../services/p2p.js';
import { dmKeyService } from '../services/dm-keys.js';
import { encryptDmMessage, decryptDmMessage } from '../services/crypto.js';
import { parseEncryptedEnvelope } from '@pingio/shared';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Encrypt a DM when the peer has published an encryption identity key;
// plaintext only when they haven't. Encryption failure fails closed — no
// plaintext downgrade of a message the user expects to be encrypted.
async function encryptDmIfPossible(
  recipientId: string,
  recipientName: string,
  content: string
): Promise<{ wire: string; encrypted: true } | { wire: string; encrypted: false } | { error: string }> {
  let dmKey;
  try {
    dmKey = await dmKeyService.getDmKey(recipientId);
  } catch (error) {
    // Could not verify the peer's encryption state — do not silently downgrade.
    return { error: `Could not verify @${recipientName}'s encryption key — message not sent (${(error as Error).message})` };
  }
  if (!dmKey) {
    return { wire: content, encrypted: false };
  }
  const myId = configManager.getConfig().identity.userId;
  if (!myId) return { wire: content, encrypted: false };
  try {
    return { wire: encryptDmMessage(dmKey.key, dmKey.keyId, myId, recipientId, content), encrypted: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function sendMessage(recipient: string, content: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  // Find contact
  const contacts = storageService.getContacts();
  const contact = contacts.find(c => c.username === recipient);

  if (!contact) {
    // Try to get recipient ID from server
    try {
      const response = await axios.get(`${relayUrl}/api/users/search?q=${encodeURIComponent(recipient)}&limit=1`, {
        headers: { Authorization: `Bearer ${config.identity.authToken}` },
      });

      const user = response.data.users.find((u: { username: string }) => u.username === recipient);
      if (!user) {
        return { content: [{ type: 'text', text: `User "${recipient}" not found. Add them as a contact first.` }], isError: true };
      }

      const enc = await encryptDmIfPossible(user.id, recipient, content);
      if ('error' in enc) {
        return { content: [{ type: 'text', text: `Error: ${enc.error}` }], isError: true };
      }

      // Send via relay
      relayClient.sendMessage(user.id, enc.wire);

      return {
        content: [{ type: 'text', text: enc.encrypted ? `✓ @${recipient} 🔒` : `✓ @${recipient}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Failed to send message: ${(error as Error).message}` }], isError: true };
    }
  }

  // Check if blocked
  if (contact.isBlocked) {
    return { content: [{ type: 'text', text: `Cannot send message: @${recipient} is blocked.` }], isError: true };
  }

  // Try P2P first if available
  if (p2pService.isPeerAvailable(contact.contactId)) {
    // P2P would be used here in full implementation
  }

  const enc = await encryptDmIfPossible(contact.contactId, recipient, content);
  if ('error' in enc) {
    return { content: [{ type: 'text', text: `Error: ${enc.error}` }], isError: true };
  }

  // Send via relay
  relayClient.sendMessage(contact.contactId, enc.wire);

  // Save to local storage (plaintext — local history stays readable)
  const message = {
    id: uuidv4(),
    senderId: config.identity.userId || '',
    senderUsername: config.identity.username || '',
    recipientId: contact.contactId,
    content,
    isEphemeral: storageService.getChatSettings(contact.contactId)?.isEphemeral || false,
    createdAt: new Date(),
    isDelivered: false,
  };
  storageService.saveMessage(contact.contactId, message);

  return {
    content: [{ type: 'text', text: enc.encrypted ? `✓ @${recipient} 🔒` : `✓ @${recipient}` }],
  };
}

export async function editMessage(messageId: string, content: string, recipient?: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Find the message in storage
  let chatId = recipient;
  if (!chatId) {
    // Search for message in all chats
    for (const [cid, messages] of storageService['messages']) {
      if (messages.find(m => m.id === messageId)) {
        chatId = cid;
        break;
      }
    }
  }

  if (!chatId) {
    return { content: [{ type: 'text', text: 'Message not found. Please specify the recipient.' }], isError: true };
  }

  // Send edit via relay
  relayClient.editMessage(messageId, content);

  // Update local storage
  storageService.updateMessage(chatId, messageId, { content, editedAt: new Date() });

  return {
    content: [{ type: 'text', text: '✓' }],
  };
}

export async function deleteMessage(messageId: string, forEveryone: boolean = false): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Send delete via relay
  relayClient.deleteMessage(messageId, forEveryone);

  return {
    content: [{ type: 'text', text: '✓' }],
  };
}

export async function getHistory(contact: string, limit: number = 20): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  // Find contact
  const contacts = storageService.getContacts();
  const contactInfo = contacts.find(c => c.username === contact);

  if (!contactInfo) {
    return { content: [{ type: 'text', text: `Contact "${contact}" not found.` }], isError: true };
  }

  try {
    // Fetch history from server
    const response = await axios.get(
      `${relayUrl}/api/messages/${contactInfo.contactId}?limit=${limit}`,
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { messages } = response.data;

    if (messages.length === 0) {
      return {
        content: [{ type: 'text', text: `No messages with @${contact}` }],
      };
    }

    // Format messages - compact format: "HH:MM username: content"
    // Encrypted DM envelopes are decrypted with the pairwise key derived from
    // the peer's published identity key (refetched once on keyId mismatch —
    // the peer may have rotated their identity).
    const myId = config.identity.userId;
    const sorted = messages
      .sort((a: { createdAt: string }, b: { createdAt: string }) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const formatted: string[] = [];
    for (const m of sorted as Array<{ senderId?: string; recipientId?: string; senderUsername: string; content: string; createdAt: string }>) {
      const date = new Date(m.createdAt);
      const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      let content = m.content;
      if (parseEncryptedEnvelope(content)) {
        const peerId = m.senderId === myId ? m.recipientId : m.senderId;
        let decrypted: string | null = null;
        let keyKnown = false;
        if (peerId && myId) {
          try {
            let dmKey = await dmKeyService.getDmKey(peerId);
            if (dmKey && parseEncryptedEnvelope(content)!.keyId !== dmKey.keyId) {
              dmKey = await dmKeyService.refreshPeerKey(peerId);
            }
            if (dmKey && parseEncryptedEnvelope(content)!.keyId === dmKey.keyId) {
              keyKnown = true;
              decrypted = decryptDmMessage(dmKey.key, myId, peerId, content);
            }
          } catch {
            // Key lookup failed (network etc.) — show placeholder, keep history readable.
            keyKnown = false;
          }
        }
        content = decrypted !== null
          ? `🔒 ${decrypted}`
          : keyKnown
            ? '🔒 [encrypted message — decryption failed]'
            : '🔒 [encrypted message — key unavailable]';
      }
      formatted.push(`${time} ${m.senderUsername}: ${content}`);
    }

    return {
      content: [{ type: 'text', text: formatted.join('\n') }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to fetch history: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to fetch history: ${(error as Error).message}` }], isError: true };
  }
}

export async function setPersistence(chatId: string, ephemeral: boolean): Promise<ToolResult> {
  const existing = storageService.getChatSettings(chatId);
  storageService.setChatSettings({
    chatId,
    chatType: existing?.chatType || 'dm',
    isEphemeral: ephemeral,
    muteNotifications: existing?.muteNotifications || false,
  });

  return {
    content: [{ type: 'text', text: ephemeral ? '✓ ephemeral' : '✓ persistent' }],
  };
}
