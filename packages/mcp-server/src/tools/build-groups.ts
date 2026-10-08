import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { relayClient } from '../services/relay.js';
import axios from 'axios';

export async function createBuildTask(
  channelId: string,
  title: string,
  description?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/channels/${channelId}/build/tasks`,
      { title, description },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { task } = response.data;
    return {
      content: [{ type: 'text', text: `✓ task ${task.id} created` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to create task: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to create task: ${(error as Error).message}` }], isError: true };
  }
}

export async function assignBuildTask(
  channelId: string,
  taskId: string,
  username: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/channels/${channelId}/build/tasks/${taskId}/assign`,
      { username },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { task } = response.data;
    return {
      content: [{ type: 'text', text: `✓ task ${task.id} assigned to @${username}` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to assign task: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to assign task: ${(error as Error).message}` }], isError: true };
  }
}

export async function getBuildTasks(
  channelId: string,
  status?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.get(
      `${relayUrl}/api/channels/${channelId}/build/tasks${status ? `?status=${status}` : ''}`,
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { tasks } = response.data;
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No tasks' }] };
    }

    const lines = tasks
      .map((t: any) => `[${t.status}] ${t.title} (id: ${t.id})${t.assignedTo ? ` assigned: ${t.assignedTo}` : ''}`)
      .join('\n');

    return { content: [{ type: 'text', text: lines }] };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to fetch tasks: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to fetch tasks: ${(error as Error).message}` }], isError: true };
  }
}

export async function completeBuildTask(
  channelId: string,
  taskId: string,
  artifactFilename?: string,
  artifactSize?: number
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.post(
      `${relayUrl}/api/channels/${channelId}/build/tasks/${taskId}/complete`,
      { artifactFilename, artifactSize },
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { task } = response.data;
    return {
      content: [{ type: 'text', text: `✓ task ${task.id} completed` }],
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to complete task: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to complete task: ${(error as Error).message}` }], isError: true };
  }
}

export async function getMemberStatuses(channelId: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const relayUrl = configManager.getRestBaseUrl();

  try {
    const response = await axios.get(
      `${relayUrl}/api/channels/${channelId}/members/status`,
      { headers: { Authorization: `Bearer ${config.identity.authToken}` } }
    );

    const { statuses } = response.data;
    if (statuses.length === 0) {
      return { content: [{ type: 'text', text: 'No status reports yet' }] };
    }

    const lines = statuses
      .map((s: any) => `${s.userId}: remaining=${s.remainingRequests ?? '?'}, context=${s.contextWindowUsed ?? '?'}, model=${s.selectedModel ?? '?'}`)
      .join('\n');

    return { content: [{ type: 'text', text: lines }] };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return { content: [{ type: 'text', text: `Failed to fetch member statuses: ${error.response?.data?.error || error.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to fetch member statuses: ${(error as Error).message}` }], isError: true };
  }
}

export async function reportSessionStatus(
  channelId: string,
  remainingRequests?: number,
  contextWindowUsed?: number,
  selectedModel?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  relayClient.sendSessionStatusReport(channelId, { remainingRequests, contextWindowUsed, selectedModel });

  return {
    content: [{ type: 'text', text: '✓ status reported' }],
  };
}

export async function requestContextClear(
  channelId: string,
  targetUsername?: string,
  taskId?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  relayClient.sendContextClearRequest(channelId, taskId, targetUsername);

  return {
    content: [{ type: 'text', text: targetUsername ? `✓ asked @${targetUsername} to clear context` : '✓ asked workers to clear context' }],
  };
}

export async function acknowledgeContextClear(
  channelId: string,
  taskId?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  relayClient.sendContextClearAck(channelId, taskId);

  return {
    content: [{ type: 'text', text: '✓ context clear acknowledged' }],
  };
}

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ARTIFACT_DIR = path.join(os.homedir(), '.pingio', 'artifacts');

function getArtifactDir(channelId: string, taskId: string): string {
  const artifactDir = process.env.LOCAL_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR;
  return path.join(artifactDir, channelId, taskId);
}

function getMaxArtifactMessageSize(): number {
  return parseInt(process.env.MAX_ARTIFACT_MESSAGE_SIZE || '1048576', 10);
}

const MAX_ARTIFACT_FILENAME_LENGTH = 255;

// Returns the filename only if it is a safe basename (no path separators, no
// traversal token, no NUL). Returns null otherwise. Legitimate artifact names
// are always basenames (produced via path.basename on upload and readdir on
// send), so anything else is rejected rather than coerced.
function safeArtifactName(filename: unknown): string | null {
  if (typeof filename !== 'string') return null;
  if (filename.length === 0 || filename.length > MAX_ARTIFACT_FILENAME_LENGTH) return null;
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\')) return null;
  if (filename === '.' || filename === '..') return null;
  if (path.basename(filename) !== filename) return null;
  return filename;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function uploadArtifact(
  channelId: string,
  taskId: string,
  filePath: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  if (!fs.existsSync(filePath)) {
    return { content: [{ type: 'text', text: `Error: File not found: ${filePath}` }], isError: true };
  }

  const dir = getArtifactDir(channelId, taskId);
  ensureDir(dir);
  const filename = path.basename(filePath);
  const dest = path.join(dir, filename);
  fs.copyFileSync(filePath, dest);

  const stats = fs.statSync(dest);
  relayClient.sendBuildTaskComplete(channelId, taskId, filename, stats.size);

  return {
    content: [{ type: 'text', text: `✓ uploaded ${filename} (${stats.size} bytes)` }],
  };
}

export async function sendArtifactPayload(
  channelId: string,
  taskId: string,
  filename: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const safeName = safeArtifactName(filename);
  if (!safeName) {
    return { content: [{ type: 'text', text: `Error: Invalid artifact filename: ${filename}` }], isError: true };
  }

  const filePath = path.join(getArtifactDir(channelId, taskId), safeName);
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: 'text', text: `Error: Artifact not found: ${safeName}` }], isError: true };
  }

  const stats = fs.statSync(filePath);
  const maxSize = getMaxArtifactMessageSize();
  if (stats.size > maxSize) {
    return {
      content: [{ type: 'text', text: `Error: Artifact ${stats.size} bytes exceeds max message size ${maxSize}` }],
      isError: true,
    };
  }

  const data = fs.readFileSync(filePath).toString('base64');
  relayClient.sendBuildArtifactPayload(channelId, taskId, safeName, data);

  return {
    content: [{ type: 'text', text: `✓ sent ${safeName} (${stats.size} bytes)` }],
  };
}

export async function downloadArtifact(
  channelId: string,
  taskId: string,
  outputDir?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const dir = outputDir || getArtifactDir(channelId, taskId);
  ensureDir(dir);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      relayClient.off('build:artifact_payload', onPayload);
      resolve({ content: [{ type: 'text', text: 'Error: Artifact transfer timed out' }], isError: true });
    }, 30000);

    function onPayload(payload: { channelId: string; taskId: string; filename: string; data: string }) {
      if (payload.channelId !== channelId || payload.taskId !== taskId) return;

      // Validate the wire-provided filename before it ever touches the path.
      // A hostile or buggy peer could otherwise supply "../../x" and write
      // outside the task directory.
      const safeName = safeArtifactName(payload.filename);
      if (!safeName) {
        // Ignore poisoned payloads and keep waiting for a well-formed one
        // rather than tearing down the transfer on the attacker's terms.
        return;
      }

      const buf = Buffer.from(payload.data, 'base64');
      const maxSize = getMaxArtifactMessageSize();
      if (buf.length > maxSize) {
        return;
      }

      const dest = path.join(dir, safeName);
      // Defense in depth: ensure the resolved path is still inside `dir`.
      const resolvedDir = path.resolve(dir);
      const resolvedDest = path.resolve(dest);
      if (resolvedDest !== path.join(resolvedDir, safeName)) {
        return;
      }

      clearTimeout(timeout);
      relayClient.off('build:artifact_payload', onPayload);

      fs.writeFileSync(dest, buf);
      resolve({ content: [{ type: 'text', text: `✓ downloaded ${safeName} to ${dir}` }] });
    }

    relayClient.on('build:artifact_payload', onPayload);
    relayClient.sendBuildArtifactRequest(channelId, taskId);
  });
}

export async function clearWorkerArtifact(
  channelId: string,
  taskId: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  relayClient.sendBuildArtifactClearRequest(channelId, taskId);

  return {
    content: [{ type: 'text', text: '✓ asked worker to clear artifact' }],
  };
}

export async function clearLocalArtifact(
  channelId: string,
  taskId: string,
  filename?: string
): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  // Validate the filename up front, before touching the filesystem, so a
  // malformed name is rejected regardless of whether the artifact dir exists.
  let safeName: string | undefined;
  if (filename) {
    const validated = safeArtifactName(filename);
    if (!validated) {
      return { content: [{ type: 'text', text: `Error: Invalid artifact filename: ${filename}` }], isError: true };
    }
    safeName = validated;
  }

  const dir = getArtifactDir(channelId, taskId);
  if (!fs.existsSync(dir)) {
    return { content: [{ type: 'text', text: 'No local artifact to clear' }] };
  }

  if (safeName) {
    const filePath = path.join(dir, safeName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  relayClient.sendBuildArtifactCleared(channelId, taskId);

  return {
    content: [{ type: 'text', text: '✓ local artifact cleared' }],
  };
}
