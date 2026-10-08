import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import { deviceService } from '../services/device.js';
import * as authClient from '../services/auth-client.js';

export async function listDevices(): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const result = await authClient.listDevices(config.identity.authToken);

  if (!result.success) {
    return { content: [{ type: 'text', text: `Failed to list devices: ${result.error}` }], isError: true };
  }

  const devices = result.devices || [];
  if (devices.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No devices registered.',
      }],
    };
  }

  const deviceList = devices.map(d => {
    const name = d.deviceName || 'Unknown Device';
    const status = d.isVerified ? '✓ Verified' : '⚠ Unverified';
    const current = d.isCurrent ? ' (This device)' : '';
    const lastSeen = d.lastSeen ? ` - Last seen: ${new Date(d.lastSeen).toLocaleString()}` : '';
    return `- ${name}${current}: ${status}${lastSeen}`;
  }).join('\n');

  return {
    content: [{
      type: 'text',
      text: `Your Devices:\n\n${deviceList}\n\nTo revoke a device: revoke_device(deviceId="xxx")`,
    }],
  };
}

export async function verifyDevice(deviceId: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const result = await authClient.verifyDevice(config.identity.authToken, deviceId);

  if (!result.success) {
    return { content: [{ type: 'text', text: `Failed to verify device: ${result.error}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Device verified successfully! The device can now access your account.`,
    }],
  };
}

export async function revokeDevice(deviceId: string): Promise<ToolResult> {
  const config = configManager.getConfig();
  if (!config.identity.authToken) {
    return { content: [{ type: 'text', text: 'Error: Not logged in' }], isError: true };
  }

  const result = await authClient.revokeDevice(config.identity.authToken, deviceId);

  if (!result.success) {
    return { content: [{ type: 'text', text: `Failed to revoke device: ${result.error}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Device revoked successfully. The device has been logged out and can no longer access your account.`,
    }],
  };
}

/**
 * Get device fingerprint for authentication
 */
export function getDeviceFingerprint(): string {
  return deviceService.getFingerprint();
}

/**
 * Get device name for authentication
 */
export function getDeviceName(): string {
  return deviceService.getDeviceName();
}
