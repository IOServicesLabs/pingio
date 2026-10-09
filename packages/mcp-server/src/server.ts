#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { dispatchTool } from './tools/dispatcher.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { AGENT_TOOL_DEFINITIONS, setAgentService } from './tools/agent.js';
import { AgentService } from './services/agent.js';
import { storageService } from './services/storage.js';
import { configManager } from './config.js';
import { relayClient } from './services/relay.js';
import { deviceService } from './services/device.js';
import { startArtifactCleanup } from './services/artifact-cleanup.js';

// Create MCP server
const server = new Server(
  {
    name: 'pingio',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

// Surface a live collab event to the host client as an MCP log notification
// (shows up as an inbox line while you work). Falls back to stderr when the
// transport isn't ready yet (e.g. event arrives during startup).
function notifyCollab(text: string): void {
  try {
    void server.sendLoggingMessage({ level: 'info', logger: 'collab', data: text });
  } catch {
    console.error(text);
  }
}

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [...TOOL_DEFINITIONS, ...AGENT_TOOL_DEFINITIONS],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, (async (request: any) => {
  const { name, arguments: args = {} } = request.params;

  try {
    return await dispatchTool(name, args);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
}) as any);

// Auto-connect if credentials exist
(async () => {
  const config = configManager.getConfig();
  if (config.identity.authToken) {
    if (config.mode !== 'self-hosted') {
      await configManager.discoverRelayUrl();
    }
    relayClient.connect(config.identity.authToken, deviceService.getFingerprint());
  }
})();

// Agent mode: incoming messages can trigger an autonomous agent turn
const agentService = new AgentService(server, relayClient, storageService, configManager);
setAgentService(agentService);
relayClient.on('message:received', (message) => agentService.handleIncomingMessage(message));

// Live collab inbox: context shares, requests and revokes surface as MCP log
// notifications so you see teammates' work snapshots without polling.
relayClient.on('collab:context_share', (share) => {
  const where = share.channelId ? `channel ${share.channelId}` : 'your DM';
  const files = share.files?.length ? `, ${share.files.length} file(s)` : '';
  notifyCollab(
    `📋 @${share.username} shared context with ${where}: [${share.status}] ${share.summary}${files} — use get_shared_context to view`
  );
});
relayClient.on('collab:context_request', (payload) => {
  const where = payload.channelId ? `channel ${payload.channelId}` : 'your DM';
  const target = payload.targetUsername ? ` (from @${payload.targetUsername})` : '';
  notifyCollab(
    `📋 @${payload.requesterUsername ?? payload.requesterId} requests current context in ${where}${target} — use share_context to respond`
  );
});
relayClient.on('collab:context_revoke', (payload) => {
  const where = payload.channelId ? `channel ${payload.channelId}` : 'your DM';
  notifyCollab(`📋 @${payload.username ?? payload.userId} stopped sharing context in ${where}`);
});

// Periodically clean up stale build-group artifact directories
startArtifactCleanup();

// Prevent crash on unhandled error events
relayClient.on('error', (err) => {
  console.error('Relay Connection Error:', err.message);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Pingio Server running on stdio');
}

main().catch(console.error);
