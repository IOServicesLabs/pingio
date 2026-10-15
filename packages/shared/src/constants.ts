// Protocol constants
export const PROTOCOL_VERSION = '1.0.0';

// Timeouts (in milliseconds)
export const CONNECTION_TIMEOUT = 30000;
export const AUTH_TIMEOUT = 10000;
export const P2P_CONNECTION_TIMEOUT = 60000;
export const TYPING_INDICATOR_DURATION = 5000;
export const PRESENCE_HEARTBEAT_INTERVAL = 30000;
export const RECONNECT_INTERVAL = 5000;
export const MAX_RECONNECT_ATTEMPTS = 10;

// Token expiry — overridable via environment (must be set before module load,
// e.g. real process env; values <= 0 or non-numeric fall back to defaults)
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const ACCESS_TOKEN_EXPIRY_MINUTES = envInt('ACCESS_TOKEN_EXPIRY_MINUTES', 60);
export const REFRESH_TOKEN_EXPIRY_DAYS = envInt('REFRESH_TOKEN_EXPIRY_DAYS', 30);
export const MAX_DEVICES_PER_USER = envInt('MAX_DEVICES_PER_USER', 5);

// Message limits
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_MESSAGES_PER_REQUEST = 100;
export const MAX_CHANNEL_NAME_LENGTH = 64;
export const MAX_USERNAME_LENGTH = 32;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_STATUS_MESSAGE_LENGTH = 128;

// Build-group artifact limits
// Default per-file decoded size limit for a build artifact (1 MiB). The MCP
// server can override the enforced limit via MAX_ARTIFACT_MESSAGE_SIZE, but
// this constant is the source of truth for the default.
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
// Longest permitted artifact filename (basename only — no path separators).
export const MAX_ARTIFACT_FILENAME_LENGTH = 255;
// Coarse ceiling on any single WebSocket frame. Bounds the base64 artifact
// payload plus its JSON envelope so a hostile/buggy peer cannot force the relay
// to buffer an unbounded frame. Precise per-artifact policy is enforced above.
export const WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

// Context sharing (work snapshots for live collaboration / pair programming)
export const MAX_CONTEXT_SUMMARY_LENGTH = 512;
export const MAX_CONTEXT_DETAILS_LENGTH = 4096;
export const MAX_CONTEXT_FILES = 50;
export const MAX_CONTEXT_FILE_LENGTH = 256;
export const MAX_CONTEXT_PROJECT_LENGTH = 128;
export const DEFAULT_CONTEXT_SHARE_TTL_MINUTES = 240;
export const MAX_CONTEXT_SHARE_TTL_MINUTES = 24 * 60;
// Git auto-capture on context shares (opt-in via includeGit)
export const MAX_CONTEXT_GIT_FILES = 20;
export const MAX_CONTEXT_GIT_BRANCH_LENGTH = 200;
export const MAX_CONTEXT_GIT_STAT_LENGTH = 300;

// Channel message retention. A channel's retention_minutes overrides the
// server-wide MESSAGE_RETENTION_MINUTES default; 0/null means keep forever.
export const MIN_CHANNEL_RETENTION_MINUTES = 60; // 1 hour
export const MAX_CHANNEL_RETENTION_MINUTES = 366 * 24 * 60; // ~1 year

// Rate limits
export const MESSAGES_PER_MINUTE = 60;
export const LOGIN_ATTEMPTS_PER_MINUTE = 5;
export const P2P_REQUESTS_PER_MINUTE = 10;

// mDNS constants
export const MDNS_SERVICE_NAME = '_pingio._tcp';
export const MDNS_SERVICE_PORT = 4567;

// Default ports
export const DEFAULT_RELAY_PORT = 3000;
export const DEFAULT_P2P_PORT = 4567;

// Storage keys
export const STORAGE_KEY_CONFIG = 'pingio-config';
export const STORAGE_KEY_MESSAGES = 'pingio-messages';
export const STORAGE_KEY_CONTACTS = 'pingio-contacts';

// Error messages
export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Access denied',
  NOT_FOUND: 'Resource not found',
  CONFLICT: 'Resource already exists',
  VALIDATION_ERROR: 'Invalid input data',
  RATE_LIMITED: 'Rate limit exceeded',
  INTERNAL_ERROR: 'Internal server error',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
  P2P_CONNECTION_FAILED: 'P2P connection failed',
  RELAY_CONNECTION_FAILED: 'Relay connection failed',
  USER_NOT_FOUND: 'User not found',
  CHANNEL_NOT_FOUND: 'Channel not found',
  MESSAGE_NOT_FOUND: 'Message not found',
  INVALID_CREDENTIALS: 'Invalid username or password',
  USERNAME_TAKEN: 'Username already taken',
  ALREADY_CONTACT: 'User is already in your contacts',
  NOT_CONTACT: 'User is not in your contacts',
  ALREADY_IN_CHANNEL: 'You are already a member of this channel',
  NOT_IN_CHANNEL: 'You are not a member of this channel',
  CHANNEL_FULL: 'Channel has reached maximum capacity',
  INVALID_INVITE_CODE: 'Invalid or expired invite code',
  NOT_MUTUAL_CONTACT: 'You can only message users who have added you back as a contact',
  BLOCKED: 'You have been blocked by this user',
  DEVICE_VERIFICATION_REQUIRED: 'Login from new device detected. Verify from a trusted device.',
  DEVICE_NOT_FOUND: 'Device not found',
  DEVICE_REVOKED: 'This device has been revoked',
  MAX_DEVICES_REACHED: 'Maximum number of devices reached',
} as const;

// Presence statuses
export const PRESENCE_STATUSES = ['online', 'away', 'busy', 'offline'] as const;

// Default config values
export const DEFAULT_CONFIG = {
  mode: 'auto' as const,
  // Hosted service operated by IOServicesLabs — the default unless a
  // deployment overrides it via PINGIO_CLOUD_ENDPOINT or the config file.
  cloudEndpoint: 'https://pingio.ioservices.io',
  selfHosted: {
    relayUrl: 'ws://localhost:5000/ws',
    enableLocalP2P: true,
    p2pPort: 0,
  },
  preferences: {
    defaultEphemeral: false,
    notifications: true,
  },
};
