import path from 'path';
import axios from 'axios';
import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import { storageService } from '../services/storage.js';
import { captureGitContext } from '../services/git-context.js';
import {
  DEFAULT_CONTEXT_SHARE_TTL_MINUTES,
  MAX_CONTEXT_SHARE_TTL_MINUTES,
  MAX_CONTEXT_SUMMARY_LENGTH,
  MAX_CONTEXT_DETAILS_LENGTH,
  MAX_CONTEXT_FILES,
} from '@pingio/shared';
import type { ContextShare, ContextShareStatus, ContextGitInfo } from '@pingio/shared';

interface ScopeArgs {
  channelId?: string;
  recipient?: string; // username for DM scope
}

function validateScope(args: ScopeArgs): string | null {
  const count = (args.channelId ? 1 : 0) + (args.recipient ? 1 : 0);
  if (count !== 1) {
    return 'Provide exactly one of channelId (channel) or recipient (DM username)';
  }
  return null;
}

// Resolve a username to a user id: local contacts first, then the
// relay's user search (mirrors sendMessage in messaging.ts). Exported for
// reuse by the channel admin tools.
export async function resolveUserId(username: string, authToken: string): Promise<{ id: string } | { error: string }> {
  const contacts = storageService.getContacts();
  const contact = contacts.find(c => c.username === username);
  if (contact) {
    if (contact.isBlocked) {
      return { error: `@${username} is blocked. Unblock them first.` };
    }
    return { id: contact.contactId };
  }

  const relayUrl = configManager.getRestBaseUrl();
  try {
    const response = await axios.get(
      `${relayUrl}/api/users/search?q=${encodeURIComponent(username)}&limit=10`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    const user = response.data.users.find((u: { username: string }) => u.username === username);
    if (!user) {
      return { error: `User "${username}" not found.` };
    }
    return { id: user.id };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { error: `Failed to resolve user: ${error.response?.data?.error || error.message}` };
    }
    return { error: `Failed to resolve user: ${(error as Error).message}` };
  }
}

function formatShare(share: ContextShare): string {
  const updated = new Date(share.updatedAt);
  const time = `${updated.getHours().toString().padStart(2, '0')}:${updated.getMinutes().toString().padStart(2, '0')}`;
  const expiresInMs = new Date(share.expiresAt).getTime() - Date.now();
  const expiresIn = expiresInMs > 0 ? `, expires in ${Math.round(expiresInMs / 60000)}m` : ', expired';
  const project = share.project ? ` (${share.project})` : '';
  const task = share.taskId ? ` [task ${share.taskId}]` : '';
  let text = `@${share.username} [${share.status}] ${share.summary}${project}${task} — ${time}${expiresIn}`;
  if (share.git) {
    const stat = share.git.diffStat ? ` (${share.git.diffStat})` : '';
    const changed = share.git.changedFiles?.length ? ` — ${share.git.changedFiles.join(', ')}` : '';
    text += `\n  git: ${share.git.branch}${share.git.dirty ? '*' : ''}${stat}${changed}`;
  }
  if (share.files && share.files.length > 0) {
    text += `\n  files: ${share.files.join(', ')}`;
  }
  if (share.details) {
    text += `\n  ${share.details}`;
  }
  return text;
}

export async function shareContext(opts: {
  summary: string;
  channelId?: string;
  recipient?: string;
  details?: string;
  files?: string[];
  status?: ContextShareStatus;
  ttlMinutes?: number;
  taskId?: string;
  includeGit?: boolean;
}): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const scopeError = validateScope(opts);
  if (scopeError) {
    return { content: [{ type: 'text', text: `Error: ${scopeError}` }], isError: true };
  }

  if (!opts.summary || opts.summary.length > MAX_CONTEXT_SUMMARY_LENGTH) {
    return { content: [{ type: 'text', text: `Error: summary is required (max ${MAX_CONTEXT_SUMMARY_LENGTH} chars)` }], isError: true };
  }
  if (opts.details && opts.details.length > MAX_CONTEXT_DETAILS_LENGTH) {
    return { content: [{ type: 'text', text: `Error: details too long (max ${MAX_CONTEXT_DETAILS_LENGTH} chars)` }], isError: true };
  }
  if (opts.files && opts.files.length > MAX_CONTEXT_FILES) {
    return { content: [{ type: 'text', text: `Error: too many files (max ${MAX_CONTEXT_FILES})` }], isError: true };
  }

  const ttlMinutes = Math.min(
    Math.max(opts.ttlMinutes ?? DEFAULT_CONTEXT_SHARE_TTL_MINUTES, 1),
    MAX_CONTEXT_SHARE_TTL_MINUTES
  );

  let recipientId: string | undefined;
  if (opts.recipient) {
    const resolved = await resolveUserId(opts.recipient, config.identity.authToken);
    if ('error' in resolved) {
      return { content: [{ type: 'text', text: `Error: ${resolved.error}` }], isError: true };
    }
    recipientId = resolved.id;
  }

  // Opt-in: attach the local working-tree state (branch, dirty files, shortstat).
  // Never on by default — it exposes repo metadata to the conversation.
  let git: ContextGitInfo | undefined;
  let gitNote = '';
  if (opts.includeGit) {
    const captured = await captureGitContext();
    if (captured) {
      git = captured;
      gitNote = ` on ${captured.branch}${captured.dirty ? '*' : ''}`;
    } else {
      gitNote = ' (git unavailable: not a repo)';
    }
  }

  relayClient.sendContextShare(
    { channelId: opts.channelId, recipientId },
    {
      summary: opts.summary,
      details: opts.details,
      files: opts.files,
      status: opts.status,
      project: path.basename(process.cwd()),
      git,
      taskId: opts.taskId,
      ttlMinutes,
    }
  );

  const where = opts.channelId ? `#channel` : `@${opts.recipient}`;
  return {
    content: [{ type: 'text', text: `✓ context shared with ${where}${gitNote} (expires in ${Math.round(ttlMinutes / 60 * 10) / 10}h)` }],
  };
}

export async function getSharedContext(opts: { channelId?: string; contact?: string }): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const count = (opts.channelId ? 1 : 0) + (opts.contact ? 1 : 0);
  if (count !== 1) {
    return { content: [{ type: 'text', text: 'Error: Provide exactly one of channelId (channel) or contact (DM username)' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();
  const headers = { Authorization: `Bearer ${config.identity.authToken}` };

  let url: string;
  let where: string;
  if (opts.channelId) {
    url = `${relayUrl}/api/channels/${opts.channelId}/context`;
    where = `#channel`;
  } else {
    const contacts = storageService.getContacts();
    const contact = contacts.find(c => c.username === opts.contact);
    if (!contact) {
      return { content: [{ type: 'text', text: `Contact "${opts.contact}" not found. Add them as a contact first.` }], isError: true };
    }
    url = `${relayUrl}/api/context/dm/${contact.contactId}`;
    where = `@${opts.contact}`;
  }

  try {
    const response = await axios.get(url, { headers });
    const shares: ContextShare[] = response.data.shares;

    if (!shares || shares.length === 0) {
      return { content: [{ type: 'text', text: `No shared context in ${where}` }] };
    }

    const text = shares.map(formatShare).join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to fetch shared context: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to fetch shared context: ${(error as Error).message}` }], isError: true };
  }
}

export async function requestContextShare(opts: {
  channelId?: string;
  recipient?: string;
  targetUsername?: string;
}): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const scopeError = validateScope(opts);
  if (scopeError) {
    return { content: [{ type: 'text', text: `Error: ${scopeError}` }], isError: true };
  }

  let recipientId: string | undefined;
  if (opts.recipient) {
    const resolved = await resolveUserId(opts.recipient, config.identity.authToken);
    if ('error' in resolved) {
      return { content: [{ type: 'text', text: `Error: ${resolved.error}` }], isError: true };
    }
    recipientId = resolved.id;
  }

  relayClient.sendContextShareRequest({
    channelId: opts.channelId,
    recipientId,
    targetUsername: opts.targetUsername,
  });

  const where = opts.channelId
    ? `#channel${opts.targetUsername ? ` (@${opts.targetUsername})` : ''}`
    : `@${opts.recipient}`;
  return { content: [{ type: 'text', text: `✓ context share requested from ${where}` }] };
}

export async function stopSharingContext(opts: { channelId?: string; recipient?: string }): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const scopeError = validateScope(opts);
  if (scopeError) {
    return { content: [{ type: 'text', text: `Error: ${scopeError}` }], isError: true };
  }

  let recipientId: string | undefined;
  if (opts.recipient) {
    const resolved = await resolveUserId(opts.recipient, config.identity.authToken);
    if ('error' in resolved) {
      return { content: [{ type: 'text', text: `Error: ${resolved.error}` }], isError: true };
    }
    recipientId = resolved.id;
  }

  relayClient.sendContextShareRevoke({ channelId: opts.channelId, recipientId });

  const where = opts.channelId ? `#channel` : `@${opts.recipient}`;
  return { content: [{ type: 'text', text: `✓ stopped sharing context with ${where}` }] };
}
