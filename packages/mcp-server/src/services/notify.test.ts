import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import type { Message, UserConfig } from '@pingio/shared';
import { configManager } from '../config.js';
import { NotifyService } from './notify.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    return child;
  }),
}));

const mockedSpawn = vi.mocked(spawn);
let getConfigSpy: MockInstance;

function makeConfig(overrides: {
  notifications?: boolean;
  mode?: 'off' | 'toast' | 'sound' | 'both';
  channels?: boolean;
  userId?: string;
}): UserConfig {
  return {
    mode: 'auto',
    cloudEndpoint: 'https://pingio.ioservices.io',
    selfHosted: { relayUrl: 'ws://localhost:5000/ws', enableLocalP2P: true, p2pPort: 0 },
    identity: { username: 'me', authToken: 'tok', userId: overrides.userId ?? 'me-id' },
    preferences: {
      defaultEphemeral: false,
      notifications: overrides.notifications ?? true,
      notify: { mode: overrides.mode ?? 'both', channels: overrides.channels ?? false },
    },
  } as UserConfig;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    senderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    senderUsername: 'alice',
    recipientId: 'me-id',
    content: 'hello there',
    isEphemeral: false,
    createdAt: new Date(),
    ...overrides,
  } as Message;
}

// Decode the -EncodedCommand payload of the (single) powershell spawn.
function decodedCommand(): string {
  expect(mockedSpawn).toHaveBeenCalled();
  const args = mockedSpawn.mock.calls[0][1] as string[];
  const idx = args.indexOf('-EncodedCommand');
  return Buffer.from(args[idx + 1], 'base64').toString('utf16le');
}

describe('NotifyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: everything enabled; individual tests re-mockReturnValue.
    getConfigSpy = vi
      .spyOn(configManager, 'getConfig')
      .mockReturnValue(makeConfig({ mode: 'both' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does nothing when the master notifications switch is off', () => {
    getConfigSpy.mockReturnValue(makeConfig({ notifications: false, mode: 'both' }));
    new NotifyService().messageReceived(makeMessage());
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('does nothing when mode is off', () => {
    getConfigSpy.mockReturnValue(makeConfig({ mode: 'off' }));
    new NotifyService().messageReceived(makeMessage());
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('fires one powershell toast+sound for a DM from someone else', () => {
    new NotifyService().messageReceived(makeMessage({ content: 'deploy is live' }));

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn.mock.calls[0][0]).toBe('powershell.exe');
    const script = decodedCommand();
    expect(script).toContain('NotifyIcon'); // toast
    expect(script).toContain('SystemSounds'); // sound
    expect(script).toContain('@alice');
    expect(script).toContain('deploy is live');
  });

  it('escapes single quotes in message content for PowerShell', () => {
    new NotifyService().messageReceived(makeMessage({ content: "it's fine" }));
    expect(decodedCommand()).toContain("it''s fine");
  });

  it('never notifies for your own messages', () => {
    new NotifyService().messageReceived(
      makeMessage({ senderId: 'me-id', senderUsername: 'me' })
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('skips channel messages unless channels are enabled', () => {
    const channelMsg = makeMessage({
      channelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    new NotifyService().messageReceived(channelMsg);
    expect(mockedSpawn).not.toHaveBeenCalled();

    getConfigSpy.mockReturnValue(makeConfig({ mode: 'both', channels: true }));
    new NotifyService().messageReceived(channelMsg);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(decodedCommand()).toContain('#cccccccc');
  });

  it('throttles bursts from the same sender within 3s', () => {
    const svc = new NotifyService();
    svc.messageReceived(makeMessage());
    svc.messageReceived(
      makeMessage({ content: 'second', id: '22222222-2222-4222-8222-222222222222' })
    );
    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3100);
    svc.messageReceived(
      makeMessage({ content: 'third', id: '33333333-3333-4333-8333-333333333333' })
    );
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });

  it('strips the lock emoji and truncates long previews', () => {
    new NotifyService().messageReceived(
      makeMessage({ content: `🔒 ${'x'.repeat(200)}` })
    );
    const script = decodedCommand();
    expect(script).not.toContain('🔒');
    // 80-char preview + PowerShell quotes stays well under the full 200
    expect(script).not.toContain('x'.repeat(150));
  });

  it('collab events notify when enabled', () => {
    new NotifyService().collabEvent('context shared', '@bob: fixing the relay');
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(decodedCommand()).toContain('context shared');
  });

  it('swallows spawn errors without throwing', () => {
    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('powershell missing');
    });
    expect(() => new NotifyService().messageReceived(makeMessage())).not.toThrow();
  });
});
