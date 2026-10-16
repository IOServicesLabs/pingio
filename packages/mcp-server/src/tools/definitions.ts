export const TOOL_DEFINITIONS = [
  // Auth tools
  {
    name: 'register_user',
    description: 'Register a new user account',
    inputSchema: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'Unique username (3-32 chars, alphanumeric + underscore/hyphen)',
        },
        password: {
          type: 'string',
          description: 'Password (min 8 chars)',
        },
        displayName: {
          type: 'string',
          description: 'Optional display name',
        },
      },
      required: ['username', 'password'],
    },
  },
  {
    name: 'login',
    description: 'Log in to your account',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['username', 'password'],
    },
  },
  {
    name: 'logout',
    description: 'Log out and clear local data',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'whoami',
    description: 'Show current user information',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_sso_providers',
    description: 'List the enterprise SSO (OIDC) providers configured on the auth server',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'login_sso',
    description:
      'Start an enterprise SSO login: returns a browser URL to authenticate with your company identity provider, then finish with complete_sso_login',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'SSO provider slug (see list_sso_providers). Omit to list available providers.',
        },
      },
    },
  },
  {
    name: 'complete_sso_login',
    description: 'Complete an SSO login with the one-time code shown in the browser after authenticating',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'One-time code shown after browser SSO (format XXXX-XXXX-XXXX)',
        },
      },
      required: ['code'],
    },
  },

  // Contact tools
  {
    name: 'add_contact',
    description: 'Add a user to your contacts',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        customName: {
          type: 'string',
          description: 'Optional custom name for this contact',
        },
      },
      required: ['username'],
    },
  },
  {
    name: 'remove_contact',
    description: 'Remove a contact',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    },
  },
  {
    name: 'list_contacts',
    description: 'List all contacts with presence status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'block_contact',
    description: 'Block or unblock a contact',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        block: {
          type: 'boolean',
          description: 'True to block, false to unblock',
        },
      },
      required: ['username', 'block'],
    },
  },
  {
    name: 'search_users',
    description: 'Search for users by username',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },

  // Messaging tools
  {
    name: 'send_message',
    description: 'Send a direct message to a user',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['recipient', 'content'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a previously sent message',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        content: { type: 'string' },
        recipient: {
          type: 'string',
          description: 'Username of the recipient (for DMs)',
        },
      },
      required: ['messageId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        forEveryone: {
          type: 'boolean',
          description: 'Delete for everyone (vs just for you)',
        },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'get_history',
    description: 'Get message history with a contact',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string' },
        limit: {
          type: 'number',
          description: 'Number of messages to fetch (default 50)',
        },
      },
      required: ['contact'],
    },
  },
  {
    name: 'set_persistence',
    description: 'Set message persistence for a chat',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        ephemeral: {
          type: 'boolean',
          description: 'True for ephemeral (no storage), false for persistent',
        },
      },
      required: ['chatId', 'ephemeral'],
    },
  },

  // Channel tools
  {
    name: 'create_channel',
    description: 'Create a new channel, social group, or build group',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique channel name (URL-friendly)',
        },
        displayName: {
          type: 'string',
          description: 'Human-readable channel name',
        },
        isPublic: {
          type: 'boolean',
          description: 'Whether the channel is publicly discoverable',
        },
        channelType: {
          type: 'string',
          enum: ['social', 'build'],
          description: 'social = regular chat group, build = agent build group',
        },
        buildPrompt: {
          type: 'string',
          description: 'Owner prompt for build groups',
        },
        maxMembers: {
          type: 'number',
          description: 'Maximum members (default 50)',
        },
        encrypted: {
          type: 'boolean',
          description:
            'Enable end-to-end encryption: the relay only stores ciphertext, keys stay on member devices',
        },
      },
      required: ['name', 'displayName'],
    },
  },
  {
    name: 'join_channel',
    description: 'Join a channel by ID',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'join_channel_by_invite',
    description: 'Join a channel using an invite code',
    inputSchema: {
      type: 'object',
      properties: {
        inviteCode: { type: 'string' },
      },
      required: ['inviteCode'],
    },
  },
  {
    name: 'leave_channel',
    description: 'Leave a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'list_channels',
    description: 'List channels you belong to (or public channels)',
    inputSchema: {
      type: 'object',
      properties: {
        publicOnly: {
          type: 'boolean',
          description: 'List only public channels you can join',
        },
      },
    },
  },
  {
    name: 'send_channel_message',
    description: 'Send a message to a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['channelId', 'content'],
    },
  },
  {
    name: 'get_channel_history',
    description: 'Get message history for a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'invite_to_channel',
    description: 'Invite a contact to a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        username: { type: 'string' },
      },
      required: ['channelId', 'username'],
    },
  },
  {
    name: 'kick_channel_member',
    description:
      'Kick a member from a channel (admin required; only the owner can kick an admin; the owner cannot be kicked)',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        username: { type: 'string' },
      },
      required: ['channelId', 'username'],
    },
  },
  {
    name: 'set_channel_member_role',
    description:
      "Change a member's role in a channel (admin required; only the owner can grant/revoke admin; role 'owner' transfers ownership and makes you an admin)",
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        username: { type: 'string' },
        role: { type: 'string', enum: ['member', 'admin', 'owner'] },
      },
      required: ['channelId', 'username', 'role'],
    },
  },
  {
    name: 'get_channel_audit_log',
    description: 'Read a channel\'s audit log of membership and security events (owner/admin only), newest first',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'set_channel_retention',
    description:
      'Set a channel\'s message retention policy in minutes (owner/admin only). Messages older than the TTL are purged hourly. Omit retentionMinutes (or pass null) to clear the override and inherit the server default',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        retentionMinutes: { type: 'number', description: 'Minutes to keep messages (60 to 527040). Omit/null to inherit the server default' },
      },
      required: ['channelId'],
    },
  },

  // Encryption tools (channel end-to-end encryption)
  {
    name: 'publish_encryption_key',
    description:
      'Publish your end-to-end encryption identity public key so channel members can share channel keys with you and DM peers can encrypt messages to you',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dm_encryption_status',
    description:
      "Show DM encryption status with a user: whether messages are end-to-end encrypted, both identity fingerprints, and the pairwise safety number to compare out-of-band",
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    },
  },
  {
    name: 'enable_channel_encryption',
    description:
      'Enable end-to-end encryption on a channel (admin) and distribute the channel key to all members with published keys; members re-run it to share with newly joined members',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'rotate_channel_key',
    description:
      'Distribute a fresh channel encryption key (old messages stay readable; future messages use the new key)',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'sync_channel_keys',
    description:
      'Fetch and unwrap your pending channel key shares — needed to read encrypted channels on a new device or after joining',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'Sync one channel only; omit to sync all encrypted channels you belong to',
        },
      },
    },
  },

  // Build group tools
  {
    name: 'create_build_task',
    description: 'Create a new build task in a build group',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['channelId', 'title'],
    },
  },
  {
    name: 'assign_build_task',
    description: 'Assign a build task to a member by username',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
        username: { type: 'string' },
      },
      required: ['channelId', 'taskId', 'username'],
    },
  },
  {
    name: 'get_build_tasks',
    description: 'List build tasks in a build group',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'assigned', 'completed', 'failed', 'cancelled'],
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'complete_build_task',
    description: 'Mark a build task complete with optional artifact metadata',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
        artifactFilename: { type: 'string' },
        artifactSize: { type: 'number' },
      },
      required: ['channelId', 'taskId'],
    },
  },
  {
    name: 'get_member_statuses',
    description: 'Get cached session-status reports for channel members',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'report_session_status',
    description: 'Report this session\'s remaining capacity and context usage',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        remainingRequests: { type: 'number' },
        contextWindowUsed: { type: 'number' },
        selectedModel: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'request_context_clear',
    description: 'Ask a worker (or all workers) to clear context after a task',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        targetUsername: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'acknowledge_context_clear',
    description: 'Acknowledge a context-clear request from the owner',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['channelId'],
    },
  },

  // Artifact transfer tools
  {
    name: 'upload_artifact',
    description: 'Store a completed artifact locally and report task completion',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
        filePath: { type: 'string' },
      },
      required: ['channelId', 'taskId', 'filePath'],
    },
  },
  {
    name: 'send_artifact_payload',
    description: 'Send an artifact file to the owner when requested',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['channelId', 'taskId', 'filename'],
    },
  },
  {
    name: 'download_artifact',
    description: 'Request and download an artifact from the assigned worker',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
        outputDir: { type: 'string' },
      },
      required: ['channelId', 'taskId'],
    },
  },
  {
    name: 'clear_worker_artifact',
    description: 'Ask the worker to delete its local artifact copy',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['channelId', 'taskId'],
    },
  },
  {
    name: 'clear_local_artifact',
    description: 'Delete the local artifact copy and notify the owner',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        taskId: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['channelId', 'taskId'],
    },
  },

  // Context sharing tools (work snapshots for live collaboration)
  {
    name: 'share_context',
    description:
      'Share what you are working on with a channel or DM peer: an ephemeral snapshot (summary, status, files, details) that others in the conversation can pull. Re-sharing replaces your previous snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'What you are working on right now (max 512 chars)',
        },
        channelId: {
          type: 'string',
          description: 'Channel to share into (mutually exclusive with recipient)',
        },
        recipient: {
          type: 'string',
          description: 'DM peer username (mutually exclusive with channelId)',
        },
        details: {
          type: 'string',
          description: 'Optional freeform details: plan, error output, diff summary (max 4096 chars)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of files currently in play (max 50)',
        },
        status: {
          type: 'string',
          enum: ['working', 'blocked', 'reviewing', 'done'],
          description: 'Current state of the work (default working)',
        },
        ttlMinutes: {
          type: 'number',
          description: 'Minutes until the snapshot expires (default 240, max 1440)',
        },
        taskId: {
          type: 'string',
          description: 'Optional build task ID this context relates to',
        },
        includeGit: {
          type: 'boolean',
          description:
            'Attach local git state (branch, dirty files, diff stat) captured from the current working directory',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'get_shared_context',
    description: 'Get the work-context snapshots currently shared in a channel or DM conversation',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'Channel to read shared context from (mutually exclusive with contact)',
        },
        contact: {
          type: 'string',
          description: 'DM contact username (mutually exclusive with channelId)',
        },
      },
    },
  },
  {
    name: 'request_context_share',
    description: 'Ask a channel (or one member) or a DM peer to share their current work context',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'Channel to ask (mutually exclusive with recipient)',
        },
        recipient: {
          type: 'string',
          description: 'DM peer username (mutually exclusive with channelId)',
        },
        targetUsername: {
          type: 'string',
          description: 'Optional: ask only this member of the channel',
        },
      },
    },
  },
  {
    name: 'stop_sharing_context',
    description: 'Stop sharing your work context in a channel or DM',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'Channel to stop sharing into (mutually exclusive with recipient)',
        },
        recipient: {
          type: 'string',
          description: 'DM peer username (mutually exclusive with channelId)',
        },
      },
    },
  },

  // Presence tools
  {
    name: 'set_status',
    description: 'Set your online status',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['online', 'away', 'busy', 'offline'],
        },
        message: {
          type: 'string',
          description: 'Optional status message',
        },
      },
      required: ['status'],
    },
  },
  {
    name: 'get_user_status',
    description: 'Check if a user is online',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    },
  },
  {
    name: 'typing',
    description: 'Send typing indicator',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        isTyping: {
          type: 'boolean',
          default: true,
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'configure_notifications',
    description:
      'Show or change OS notification settings (toast/sound) for incoming Pingio messages and collab events. Call with no arguments to see current settings.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'toast', 'sound', 'both'],
          description: 'off = silent, toast = popup, sound = chime, both',
        },
        channels: {
          type: 'boolean',
          description: 'Also notify for channel/group messages (default: DMs only)',
        },
      },
    },
  },

  // Device management tools
  {
    name: 'list_devices',
    description: 'List all registered devices for your account',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'verify_device',
    description: 'Verify a new device from a trusted device',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The device ID to verify',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'revoke_device',
    description: 'Revoke a device (log it out)',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The device ID to revoke',
        },
      },
      required: ['deviceId'],
    },
  },
];

export const DEFAULT_AGENT_TOOLS = [
  'send_message',
  'send_channel_message',
  'get_history',
  'get_channel_history',
  'add_contact',
  'search_users',
  'create_channel',
  'invite_to_channel',
  'list_contacts',
  'list_channels',
  'set_status',
  'typing',
  'create_build_task',
  'assign_build_task',
  'get_build_tasks',
  'complete_build_task',
  'get_member_statuses',
  'report_session_status',
  'request_context_clear',
  'acknowledge_context_clear',
  'upload_artifact',
  'send_artifact_payload',
  'download_artifact',
  'clear_worker_artifact',
  'clear_local_artifact',
  'share_context',
  'get_shared_context',
  'request_context_share',
  'stop_sharing_context',
];
