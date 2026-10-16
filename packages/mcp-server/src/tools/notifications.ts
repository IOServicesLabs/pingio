import type { NotifyMode } from '@pingio/shared';
import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';

const MODES: NotifyMode[] = ['off', 'toast', 'sound', 'both'];

function currentSettingsText(): string {
  const prefs = configManager.getConfig().preferences;
  return [
    `notifications enabled (master switch): ${prefs.notifications}`,
    `mode: ${prefs.notify.mode} (off = silent, toast = popup, sound = chime, both)`,
    `channel/group messages: ${prefs.notify.channels ? 'notify too' : 'DMs only'}`,
  ].join('\n');
}

export async function configureNotifications(
  mode?: NotifyMode,
  channels?: boolean
): Promise<ToolResult> {
  if (mode !== undefined) {
    if (!MODES.includes(mode)) {
      return {
        content: [{
          type: 'text',
          text: `Invalid mode "${mode}". Must be one of: ${MODES.join(', ')}`,
        }],
        isError: true,
      };
    }
    configManager.setNotifyMode(mode);
  }
  if (channels !== undefined) {
    configManager.setNotifyChannels(channels);
  }

  return {
    content: [{
      type: 'text',
      text: [
        mode === undefined && channels === undefined
          ? 'Current notification settings:'
          : 'Notification settings updated:',
        '',
        currentSettingsText(),
        '',
        'OS toasts/sounds fire on incoming DMs and collab events while this session is connected. Also settable via PINGIO_NOTIFY / PINGIO_NOTIFY_CHANNELS env vars or ~/.pingio/config.json.',
      ].join('\n'),
    }],
  };
}
