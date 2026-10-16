import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { NotifyMode, UserConfig } from '@pingio/shared';
import { configManager } from '../config.js';
import { configureNotifications } from './notifications.js';

let baseConfig: UserConfig;

describe('configure_notifications', () => {
  let setMode: MockInstance<[NotifyMode], void>;
  let setChannels: MockInstance<[boolean], void>;

  beforeEach(() => {
    baseConfig = {
      mode: 'auto',
      cloudEndpoint: 'https://pingio.ioservices.io',
      preferences: {
        defaultEphemeral: false,
        notifications: true,
        notify: { mode: 'off' as const, channels: false },
      },
    } as unknown as UserConfig;
    vi.spyOn(configManager, 'getConfig').mockReturnValue(baseConfig);
    // Mirror production: setters mutate the config the getter reads back.
    setMode = vi
      .spyOn(configManager, 'setNotifyMode')
      .mockImplementation((m) => {
        (baseConfig.preferences.notify as { mode: string }).mode = m;
      });
    setChannels = vi
      .spyOn(configManager, 'setNotifyChannels')
      .mockImplementation((c) => {
        (baseConfig.preferences.notify as { channels: boolean }).channels = c;
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports current settings when called with no arguments', async () => {
    const result = await configureNotifications();
    expect(setMode).not.toHaveBeenCalled();
    expect(setChannels).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('mode: off');
    expect(result.content[0].text).toContain('Current notification settings');
  });

  it('updates mode and channels when provided', async () => {
    const result = await configureNotifications('both', true);
    expect(setMode).toHaveBeenCalledWith('both');
    expect(setChannels).toHaveBeenCalledWith(true);
    expect(result.content[0].text).toContain('updated');
    expect(result.content[0].text).toContain('mode: both');
    expect(result.content[0].text).toContain('channel/group messages: notify too');
  });

  it('updates only the fields that are passed', async () => {
    await configureNotifications('sound');
    expect(setMode).toHaveBeenCalledWith('sound');
    expect(setChannels).not.toHaveBeenCalled();
  });

  it('rejects an invalid mode', async () => {
    const result = await configureNotifications('loud' as never);
    expect(result.isError).toBe(true);
    expect(setMode).not.toHaveBeenCalled();
  });
});
