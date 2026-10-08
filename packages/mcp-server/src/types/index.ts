import type {
  User,
  Contact,
  Message,
  Channel,
  Presence,
  UserConfig,
  ConnectionStatus,
} from '@pingio/shared';

// Local state types
export interface LocalState {
  user: User | null;
  contacts: Map<string, LocalContact>;
  channels: Map<string, Channel>;
  messages: Map<string, LocalMessage[]>; // chatId -> messages
  chatSettings: Map<string, ChatSettings>;
  connectionStatus: ConnectionStatus;
  unreadMessages: Map<string, number>; // chatId -> count
}

export interface LocalContact extends Contact {
  lastMessage?: LocalMessage;
  unreadCount: number;
}

export interface LocalMessage extends Message {
  isDelivered?: boolean;
  isRead?: boolean;
}

export interface AgentConfig {
  enabled: boolean;
  mode: 'auto' | 'mention';
  systemPrompt?: string;
  allowedTools?: string[];
  maxIterations?: number;
  mentionKeyword?: string;
  role?: 'orchestrator' | 'worker';
  // Opt-in: automatically answer incoming context-share requests for this chat
  // with a fresh share_context snapshot. Off by default — it exposes what the
  // user is working on, so it must be enabled explicitly per chat.
  autoShareContext?: boolean;
}

export interface ChatSettings {
  chatId: string;
  chatType: 'dm' | 'channel';
  isEphemeral: boolean;
  muteNotifications: boolean;
  agent?: AgentConfig;
  channelType?: 'social' | 'build';
  ownerId?: string;
  buildPrompt?: string;
}

// P2P types
export interface P2PConnection {
  connectionId: string;
  peerUserId: string;
  peerUsername: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'failed';
  dataChannel?: RTCDataChannel;
  lastActivity: Date;
}

export interface DiscoveredPeer {
  userId: string;
  username: string;
  displayName?: string;
  address: string;
  port: number;
  lastSeen: Date;
}

// Event types for internal communication
export interface MessagingEvents {
  'message:received': (message: LocalMessage) => void;
  'message:sent': (message: LocalMessage) => void;
  'message:delivered': (messageId: string) => void;
  'message:read': (messageId: string) => void;
  'presence:update': (userId: string, presence: Presence) => void;
  'contact:added': (contact: LocalContact) => void;
  'contact:removed': (userId: string) => void;
  'channel:joined': (channel: Channel) => void;
  'channel:left': (channelId: string) => void;
  'p2p:discovered': (peer: DiscoveredPeer) => void;
  'p2p:connected': (connection: P2PConnection) => void;
  'p2p:disconnected': (connectionId: string) => void;
  'connection:status': (status: ConnectionStatus) => void;
  'typing': (userId: string, chatId: string, isTyping: boolean) => void;
}

// Tool result types
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ResourceResult {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}
