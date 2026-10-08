import type { ToolResult } from '../types/index.js';
import { registerUser, login, logout, whoami } from './auth.js';
import { addContact, removeContact, listContacts, blockContact, searchUsers } from './contacts.js';
import { sendMessage, editMessage, deleteMessage, getHistory, setPersistence } from './messaging.js';
import {
  createChannel,
  joinChannel,
  joinChannelByInvite,
  leaveChannel,
  listChannels,
  sendChannelMessage,
  getChannelHistory,
  inviteToChannel,
  kickChannelMember,
  setChannelMemberRole,
  getChannelAuditLog,
  setChannelRetention,
} from './channels.js';
import { setStatus, getUserStatus, typing } from './presence.js';
import { listDevices, verifyDevice, revokeDevice } from './devices.js';
import {
  enableAgentMode,
  disableAgentMode,
  configureAgent,
  getAgentStatus,
  triggerAgent,
} from './agent.js';
import {
  createBuildTask,
  assignBuildTask,
  getBuildTasks,
  completeBuildTask,
  getMemberStatuses,
  reportSessionStatus,
  requestContextClear,
  acknowledgeContextClear,
  uploadArtifact,
  sendArtifactPayload,
  downloadArtifact,
  clearWorkerArtifact,
  clearLocalArtifact,
} from './build-groups.js';
import {
  shareContext,
  getSharedContext,
  requestContextShare,
  stopSharingContext,
} from './collab.js';
import { listSsoProviders, loginSso, completeSsoLogin } from './sso.js';
import {
  publishEncryptionKey,
  dmEncryptionStatus,
  enableChannelEncryption,
  rotateChannelKey,
  syncChannelKeys,
} from './encryption.js';

export async function dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    // Auth
    case 'register_user':
      return await registerUser(args.username as string, args.password as string, args.displayName as string | undefined);
    case 'login':
      return await login(args.username as string, args.password as string);
    case 'logout':
      return await logout();
    case 'whoami':
      return await whoami();
    case 'list_sso_providers':
      return await listSsoProviders();
    case 'login_sso':
      return await loginSso(args.provider as string | undefined);
    case 'complete_sso_login':
      return await completeSsoLogin(args.code as string);

    // Contacts
    case 'add_contact':
      return await addContact(args.username as string, args.customName as string | undefined);
    case 'remove_contact':
      return await removeContact(args.username as string);
    case 'list_contacts':
      return await listContacts();
    case 'block_contact':
      return await blockContact(args.username as string, args.block as boolean);
    case 'search_users':
      return await searchUsers(args.query as string);

    // Messaging
    case 'send_message':
      return await sendMessage(args.recipient as string, args.content as string);
    case 'edit_message':
      return await editMessage(args.messageId as string, args.content as string, args.recipient as string | undefined);
    case 'delete_message':
      return await deleteMessage(args.messageId as string, args.forEveryone as boolean | undefined);
    case 'get_history':
      return await getHistory(args.contact as string, args.limit as number | undefined);
    case 'set_persistence':
      return await setPersistence(args.chatId as string, args.ephemeral as boolean);

    // Channels
    case 'create_channel':
      return await createChannel(
        args.name as string,
        args.displayName as string,
        args.isPublic as boolean | undefined,
        (args.channelType as 'social' | 'build') || 'social',
        args.buildPrompt as string | undefined,
        args.maxMembers as number | undefined,
        args.encrypted as boolean | undefined
      );
    case 'join_channel':
      return await joinChannel(args.channelId as string);
    case 'join_channel_by_invite':
      return await joinChannelByInvite(args.inviteCode as string);
    case 'leave_channel':
      return await leaveChannel(args.channelId as string);
    case 'list_channels':
      return await listChannels(args.publicOnly as boolean | undefined);
    case 'send_channel_message':
      return await sendChannelMessage(args.channelId as string, args.content as string);
    case 'get_channel_history':
      return await getChannelHistory(args.channelId as string, args.limit as number | undefined);
    case 'invite_to_channel':
      return await inviteToChannel(args.channelId as string, args.username as string);
    case 'kick_channel_member':
      return await kickChannelMember(args.channelId as string, args.username as string);
    case 'set_channel_member_role':
      return await setChannelMemberRole(
        args.channelId as string,
        args.username as string,
        args.role as 'member' | 'admin' | 'owner'
      );
    case 'get_channel_audit_log':
      return await getChannelAuditLog(args.channelId as string, args.limit as number | undefined);
    case 'set_channel_retention':
      return await setChannelRetention(args.channelId as string, (args.retentionMinutes as number | null | undefined) ?? null);

    // Encryption
    case 'publish_encryption_key':
      return await publishEncryptionKey();
    case 'dm_encryption_status':
      return await dmEncryptionStatus(args.username as string);
    case 'enable_channel_encryption':
      return await enableChannelEncryption(args.channelId as string);
    case 'rotate_channel_key':
      return await rotateChannelKey(args.channelId as string);
    case 'sync_channel_keys':
      return await syncChannelKeys(args.channelId as string | undefined);

    // Presence
    case 'set_status':
      return await setStatus(args.status as 'online' | 'away' | 'busy' | 'offline', args.message as string | undefined);
    case 'get_user_status':
      return await getUserStatus(args.username as string);
    case 'typing':
      return await typing(args.recipient as string, args.isTyping as boolean | undefined);

    // Devices
    case 'list_devices':
      return await listDevices();
    case 'verify_device':
      return await verifyDevice(args.deviceId as string);
    case 'revoke_device':
      return await revokeDevice(args.deviceId as string);

    // Agent management
    case 'enable_agent_mode':
      return await enableAgentMode(
        args.chatId as string,
        args.chatType as 'dm' | 'channel',
        (args.mode as 'auto' | 'mention') || 'auto',
        args.systemPrompt as string | undefined,
        args.allowedTools as string[] | undefined,
        args.maxIterations as number | undefined,
        args.mentionKeyword as string | undefined,
        args.channelType as 'social' | 'build' | undefined,
        args.ownerId as string | undefined,
        args.buildPrompt as string | undefined,
        args.role as 'orchestrator' | 'worker' | undefined,
        args.autoShareContext as boolean | undefined
      );
    case 'disable_agent_mode':
      return await disableAgentMode(args.chatId as string);
    case 'configure_agent':
      return await configureAgent(args.chatId as string, {
        mode: args.mode as 'auto' | 'mention' | undefined,
        systemPrompt: args.systemPrompt as string | undefined,
        allowedTools: args.allowedTools as string[] | undefined,
        maxIterations: args.maxIterations as number | undefined,
        mentionKeyword: args.mentionKeyword as string | undefined,
        autoShareContext: args.autoShareContext as boolean | undefined,
        role: args.role as 'orchestrator' | 'worker' | undefined,
        channelType: args.channelType as 'social' | 'build' | undefined,
        ownerId: args.ownerId as string | undefined,
        buildPrompt: args.buildPrompt as string | undefined,
      });
    case 'get_agent_status':
      return await getAgentStatus(args.chatId as string | undefined);
    case 'trigger_agent':
      return await triggerAgent(args.chatId as string, args.task as string);

    // Build groups
    case 'create_build_task':
      return await createBuildTask(args.channelId as string, args.title as string, args.description as string | undefined);
    case 'assign_build_task':
      return await assignBuildTask(args.channelId as string, args.taskId as string, args.username as string);
    case 'get_build_tasks':
      return await getBuildTasks(args.channelId as string, args.status as string | undefined);
    case 'complete_build_task':
      return await completeBuildTask(
        args.channelId as string,
        args.taskId as string,
        args.artifactFilename as string | undefined,
        args.artifactSize as number | undefined
      );
    case 'get_member_statuses':
      return await getMemberStatuses(args.channelId as string);
    case 'report_session_status':
      return await reportSessionStatus(
        args.channelId as string,
        args.remainingRequests as number | undefined,
        args.contextWindowUsed as number | undefined,
        args.selectedModel as string | undefined
      );
    case 'request_context_clear':
      return await requestContextClear(
        args.channelId as string,
        args.targetUsername as string | undefined,
        args.taskId as string | undefined
      );
    case 'acknowledge_context_clear':
      return await acknowledgeContextClear(args.channelId as string, args.taskId as string | undefined);

    // Artifact transfer
    case 'upload_artifact':
      return await uploadArtifact(args.channelId as string, args.taskId as string, args.filePath as string);
    case 'send_artifact_payload':
      return await sendArtifactPayload(args.channelId as string, args.taskId as string, args.filename as string);
    case 'download_artifact':
      return await downloadArtifact(args.channelId as string, args.taskId as string, args.outputDir as string | undefined);
    case 'clear_worker_artifact':
      return await clearWorkerArtifact(args.channelId as string, args.taskId as string);
    case 'clear_local_artifact':
      return await clearLocalArtifact(args.channelId as string, args.taskId as string, args.filename as string | undefined);

    // Context sharing
    case 'share_context':
      return await shareContext({
        summary: args.summary as string,
        channelId: args.channelId as string | undefined,
        recipient: args.recipient as string | undefined,
        details: args.details as string | undefined,
        files: args.files as string[] | undefined,
        status: args.status as 'working' | 'blocked' | 'reviewing' | 'done' | undefined,
        ttlMinutes: args.ttlMinutes as number | undefined,
        taskId: args.taskId as string | undefined,
        includeGit: args.includeGit as boolean | undefined,
      });
    case 'get_shared_context':
      return await getSharedContext({
        channelId: args.channelId as string | undefined,
        contact: args.contact as string | undefined,
      });
    case 'request_context_share':
      return await requestContextShare({
        channelId: args.channelId as string | undefined,
        recipient: args.recipient as string | undefined,
        targetUsername: args.targetUsername as string | undefined,
      });
    case 'stop_sharing_context':
      return await stopSharingContext({
        channelId: args.channelId as string | undefined,
        recipient: args.recipient as string | undefined,
      });

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
