import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import { channelKeyStore } from '../services/channel-keys.js';
import { encryptChannelMessage, decryptChannelMessage } from '../services/crypto.js';
import { enableChannelEncryption } from './encryption.js';
import { resolveUserId } from './collab.js';
import axios from 'axios';
import { validateChannelName, parseEncryptedEnvelope } from '@pingio/shared';

export async function createChannel(
  name: string,
  displayName: string,
  isPublic: boolean = false,
  channelType: 'social' | 'build' = 'social',
  buildPrompt?: string,
  maxMembers: number = 50,
  encrypted: boolean = false
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Validate channel name
  const nameValidation = validateChannelName(name);
  if (!nameValidation.valid) {
    return { content: [{ type: 'text', text: `Error: ${nameValidation.error}` }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/channels`,
      { name, displayName, isPublic, channelType, buildPrompt, maxMembers, encryptionEnabled: encrypted },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { channel } = response.data;

    if (!encrypted) {
      return {
        content: [{ type: 'text', text: `✓ #${name} (id: ${channel.id})` }],
      };
    }

    // Distribute the initial channel key right away so the channel is usable.
    const enableResult = await enableChannelEncryption(channel.id);
    const enableText = enableResult.content[0]?.text ?? '';
    return {
      content: [{ type: 'text', text: `✓ #${name} (id: ${channel.id}) 🔒\n${enableText}` }],
      ...(enableResult.isError ? { isError: true } : {}),
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to create channel: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to create channel: ${(error as Error).message}` }], isError: true };
  }
}

export async function joinChannel(channelId: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    await axios.post(
      `${relayUrl}/api/channels/${channelId}/join`,
      {},
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    return {
      content: [{ type: 'text', text: `✓ joined` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to join channel: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to join channel: ${(error as Error).message}` }], isError: true };
  }
}

export async function joinChannelByInvite(inviteCode: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/channels/join-by-invite`,
      { inviteCode },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { channel } = response.data;

    return {
      content: [{ type: 'text', text: `✓ joined #${channel.name} (id: ${channel.id})` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to join channel: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to join channel: ${(error as Error).message}` }], isError: true };
  }
}

export async function leaveChannel(channelId: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    await axios.post(
      `${relayUrl}/api/channels/${channelId}/leave`,
      {},
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    return {
      content: [{ type: 'text', text: '✓ left' }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to leave channel: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to leave channel: ${(error as Error).message}` }], isError: true };
  }
}

export async function listChannels(publicOnly: boolean = false): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.get(
      `${relayUrl}/api/channels${publicOnly ? '?public=true' : ''}`,
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { channels } = response.data;

    if (channels.length === 0) {
      return {
        content: [{ type: 'text', text: publicOnly ? 'No public channels' : 'No channels' }],
      };
    }

    const channelList = channels
      .map((c: { id: string; name: string; memberCount?: number; isPublic?: boolean; encryptionEnabled?: boolean }) => {
        const memberCount = c.memberCount !== undefined ? ` ${c.memberCount}` : '';
        const visibility = c.isPublic ? ' public' : ' private';
        const lock = c.encryptionEnabled ? ' 🔒' : '';
        return `#${c.name} (id: ${c.id})${visibility}${memberCount}${lock}`;
      })
      .join('\n');

    return {
      content: [{ type: 'text', text: channelList }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to list channels: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to list channels: ${(error as Error).message}` }], isError: true };
  }
}

export async function sendChannelMessage(channelId: string, content: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Encrypt when we hold a key for this channel; fail closed when the channel
  // is known to be encrypted but we don't.
  const localKey = channelKeyStore.getLatestChannelKey(channelId);
  let wireContent = content;
  let encrypted = false;

  if (localKey) {
    try {
      wireContent = encryptChannelMessage(localKey.key, localKey.keyId, channelId, content);
      encrypted = true;
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  } else {
    let enabled = channelKeyStore.getFlag(channelId);
    if (enabled === null) {
      try {
        const relayUrl = configManager.getRestBaseUrl();
        const { data } = await axios.get(`${relayUrl}/api/channels/${channelId}`, {
          headers: { Authorization: `Bearer ${config.identity.authToken}` },
        });
        enabled = data.channel?.encryptionEnabled === true;
        channelKeyStore.setFlag(channelId, enabled);
      } catch (error) {
        if (axios.isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) {
          return { content: [{ type: 'text', text: `Error: ${error.response.data?.error || 'Channel not found'}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: 'Error: Could not verify channel encryption state — message not sent' }],
          isError: true,
        };
      }
    }
    if (enabled) {
      return {
        content: [{
          type: 'text',
          text: 'Error: This channel is end-to-end encrypted but you have no key for it. Run sync_channel_keys to fetch your key share.',
        }],
        isError: true,
      };
    }
  }

  relayClient.sendChannelMessage(channelId, wireContent);

  return {
    content: [{ type: 'text', text: encrypted ? '✓ 🔒' : '✓' }],
  };
}

export async function getChannelHistory(channelId: string, limit: number = 20): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.get(
      `${relayUrl}/api/channels/${channelId}/messages?limit=${limit}`,
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { messages } = response.data;

    if (messages.length === 0) {
      return {
        content: [{ type: 'text', text: 'No messages' }],
      };
    }

    // Format messages - compact format: "HH:MM username: content"
    // Encrypted envelopes are decrypted with locally held channel keys.
    const formattedMessages = messages
      .sort((a: { createdAt: string }, b: { createdAt: string }) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((m: { senderUsername: string; content: string; createdAt: string }) => {
        const date = new Date(m.createdAt);
        const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        let content = m.content;
        const envelope = parseEncryptedEnvelope(content);
        if (envelope) {
          const key = channelKeyStore.getChannelKey(channelId, envelope.keyId);
          const plaintext = key ? decryptChannelMessage(key, channelId, content) : null;
          content = plaintext !== null ? `🔒 ${plaintext}` : '🔒 [encrypted message — run sync_channel_keys to read]';
        }
        return `${time} ${m.senderUsername}: ${content}`;
      })
      .join('\n');

    return {
      content: [{ type: 'text', text: formattedMessages }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to fetch channel history: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to fetch channel history: ${(error as Error).message}` }], isError: true };
  }
}

export async function inviteToChannel(channelId: string, username: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    await axios.post(
      `${relayUrl}/api/channels/${channelId}/invite`,
      { username },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    return {
      content: [{ type: 'text', text: `✓ @${username}` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to invite user: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to invite user: ${(error as Error).message}` }], isError: true };
  }
}

// Kick a member from a channel. Requires admin; admins can kick members, only
// the owner can kick another admin, and the owner can never be kicked.
export async function kickChannelMember(channelId: string, username: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const resolved = await resolveUserId(username, config.identity.authToken);
  if ('error' in resolved) {
    return { content: [{ type: 'text', text: `Error: ${resolved.error}` }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    await axios.post(
      `${relayUrl}/api/channels/${channelId}/members/${resolved.id}/kick`,
      {},
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    return {
      content: [{ type: 'text', text: `✓ kicked @${username}` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to kick member: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to kick member: ${(error as Error).message}` }], isError: true };
  }
}

// Change a member's role. Admins can set members ↔ member/admin only via the
// owner; passing role 'owner' transfers ownership (the caller becomes admin).
export async function setChannelMemberRole(
  channelId: string,
  username: string,
  role: 'member' | 'admin' | 'owner'
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  if (!['member', 'admin', 'owner'].includes(role)) {
    return { content: [{ type: 'text', text: `Error: Invalid role "${role}" — must be member, admin, or owner` }], isError: true };
  }

  const resolved = await resolveUserId(username, config.identity.authToken);
  if ('error' in resolved) {
    return { content: [{ type: 'text', text: `Error: ${resolved.error}` }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/channels/${channelId}/members/${resolved.id}/role`,
      { role },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const transferred = response.data?.ownershipTransferred === true;
    return {
      content: [{
        type: 'text',
        text: transferred
          ? `✓ ownership transferred to @${username} — you are now an admin`
          : `✓ @${username} is now ${role}`,
      }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to change role: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to change role: ${(error as Error).message}` }], isError: true };
  }
}

// Set or clear the channel's message retention override (owner/admin only).
// Pass retentionMinutes=null to fall back to the server-wide default.
export async function setChannelRetention(channelId: string, retentionMinutes: number | null): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    await axios.post(
      `${relayUrl}/api/channels/${channelId}/retention`,
      { retentionMinutes },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const text = retentionMinutes === null
      ? '✓ retention override cleared — the server default now applies'
      : `✓ messages in this channel are now kept for ${retentionMinutes} minutes (${(retentionMinutes / 60 / 24).toFixed(1)} days), purged hourly`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to set retention: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to set retention: ${(error as Error).message}` }], isError: true };
  }
}

// Read a channel's audit log (owner/admin only). Newest events first.
export async function getChannelAuditLog(channelId: string, limit: number = 50): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.get(
      `${relayUrl}/api/channels/${channelId}/audit?limit=${limit}`,
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { events } = response.data;

    if (events.length === 0) {
      return {
        content: [{ type: 'text', text: 'No audit events' }],
      };
    }

    const formatted = events
      .map((e: {
        actorUsername?: string;
        action: string;
        targetUsername?: string;
        metadata?: Record<string, unknown>;
        createdAt: string;
      }) => {
        const date = new Date(e.createdAt);
        const time = `${date.toISOString().slice(5, 10)} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        const actor = e.actorUsername ? `@${e.actorUsername}` : 'system';
        const target = e.targetUsername ? ` @${e.targetUsername}` : '';
        const meta = e.metadata && Object.keys(e.metadata).length > 0 ? ` ${JSON.stringify(e.metadata)}` : '';
        return `${time} ${actor} ${e.action}${target}${meta}`;
      })
      .join('\n');

    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to fetch audit log: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to fetch audit log: ${(error as Error).message}` }], isError: true };
  }
}
