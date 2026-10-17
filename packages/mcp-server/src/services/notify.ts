import { spawn } from 'child_process';
import type { Message, NotifyMode } from '@pingio/shared';
import { configManager } from '../config.js';

// OS-level toast/sound notifications for incoming Pingio activity.
//
// Controlled by `preferences.notifications` (legacy master switch) plus
// `preferences.notify.mode` ('off' | 'toast' | 'sound' | 'both') and
// `preferences.notify.channels` (include channel/group messages; DMs always
// notify when enabled). All knobs are settable via the
// `configure_notifications` MCP tool, ~/.pingio/config.json, or the
// PINGIO_NOTIFY / PINGIO_NOTIFY_CHANNELS env vars.
//
// Every spawn is fire-and-forget, detached, stdio-ignored, and wrapped in
// try/catch: a broken notifier must never take down the MCP server or slow
// the message path. Failures are silent by design (terminals vary wildly).

const THROTTLE_MS = 3000; // per-key burst guard
const PREVIEW_LEN = 80;

// Single-escape text for embedding in a single-quoted PowerShell string.
function psEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function psQuote(text: string): string {
  return `'${psEscape(text)}'`;
}

// XML-escape text destined for the toast XML payload.
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// UTF-16LE base64, the robust way to hand a script to powershell.exe without
// quoting/escaping surprises.
function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// Windows toast via Windows.UI.Notifications (WinRT) — the same pipeline real
// apps use, so it lands in the notification center with attribution and plays
// the system notification sound via the <audio> element. Requires
// powershell.exe (5.1, ships with Windows): its .NET Framework runtime has
// the WinRT type bridge; pwsh 7 does not.
//
// Win11 silently drops toasts from unregistered app IDs, so the script first
// registers our AUMID under HKCU\Software\Classes\AppUserModelId (idempotent,
// no admin, no shortcut file needed).
const WINDOWS_TOAST_APP_ID = 'IOServicesLabs.Pingio';

function windowsToastScript(title: string, body: string): string {
  const xml =
    `<toast><visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>` +
    `</binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>`;
  return [
    `New-Item -Path ${psQuote(`HKCU:\\Software\\Classes\\AppUserModelId\\${WINDOWS_TOAST_APP_ID}`)} -Force | Out-Null`,
    `New-ItemProperty -Path ${psQuote(`HKCU:\\Software\\Classes\\AppUserModelId\\${WINDOWS_TOAST_APP_ID}`)} -Name DisplayName -Value 'Pingio' -PropertyType String -Force | Out-Null`,
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()',
    `$xml.LoadXml(${psQuote(xml)})`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(WINDOWS_TOAST_APP_ID)}).Show($toast)`,
  ].join('; ');
}

// Windows system sound for sound-only mode; the process must outlive the
// async .Play() briefly.
function windowsSoundScript(): string {
  return "[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800";
}

// macOS toast via osascript; single quotes escaped AppleScript-style.
function appleScript(title: string, body: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`;
}

export class NotifyService {
  private lastFired = new Map<string, number>();

  private get mode(): NotifyMode {
    return configManager.getConfig().preferences.notify.mode;
  }

  private get enabled(): boolean {
    const prefs = configManager.getConfig().preferences;
    return prefs.notifications && this.mode !== 'off';
  }

  private throttled(key: string): boolean {
    const now = Date.now();
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < THROTTLE_MS) return true;
    this.lastFired.set(key, now);
    return false;
  }

  private run(command: string, args: string[]): void {
    try {
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.on('error', () => { /* notifier missing — fine */ });
      child.unref();
    } catch {
      /* never propagate */
    }
  }

  private fire(title: string, body: string): void {
    if (!this.enabled || this.throttled(title)) return;

    const mode = this.mode;
    const wantToast = mode === 'toast' || mode === 'both';
    const wantSound = mode === 'sound' || mode === 'both';

    switch (process.platform) {
      case 'win32': {
        // The WinRT toast carries its own <audio>, so 'both' = one spawn.
        if (wantToast) {
          this.run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
            encodePs(windowsToastScript(title, body)),
          ]);
        } else if (wantSound) {
          this.run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
            encodePs(windowsSoundScript()),
          ]);
        }
        break;
      }
      case 'darwin': {
        if (wantToast) this.run('osascript', ['-e', appleScript(title, body)]);
        else if (wantSound) this.run('afplay', ['/System/Library/Sounds/Glass.aiff']);
        break;
      }
      default: {
        if (wantToast) this.run('notify-send', [title, body]);
        if (wantSound) this.run('paplay', ['/usr/share/sounds/freedesktop/stereo/bell.oga']);
        break;
      }
    }
  }

  /** Incoming DM or channel message. Own messages and channel traffic
   *  (unless enabled) never notify. */
  messageReceived(message: Message): void {
    const myId = configManager.getConfig().identity.userId;
    if (myId && message.senderId === myId) return;

    const isChannel = !!message.channelId;
    if (isChannel && !configManager.getConfig().preferences.notify.channels) return;

    const channelId = message.channelId;
    const preview = message.content
      .replace(/^🔒\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PREVIEW_LEN);

    const title = channelId
      ? `Pingio · #${channelId.slice(0, 8)}`
      : `Pingio · @${message.senderUsername}`;
    this.fire(title, preview);
  }

  /** Collab events (context share/request/revoke) — these are rarer and
   *  higher-signal than chat, so they always notify when enabled. */
  collabEvent(title: string, body: string): void {
    this.fire(`Pingio · ${title}`, body);
  }
}

export const notifyService = new NotifyService();
