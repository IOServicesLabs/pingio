import crypto from 'crypto';
import os from 'os';

export interface DeviceFingerprint {
  fingerprint: string;
  deviceName: string;
}

class DeviceService {
  private fingerprint: string | null = null;
  private deviceName: string | null = null;

  /**
   * Generate a unique device fingerprint based on machine characteristics.
   * This fingerprint is hashed for privacy and consistency.
   */
  getFingerprint(): string {
    if (this.fingerprint) {
      return this.fingerprint;
    }

    // Collect device characteristics
    const components = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || 'unknown',
      os.totalmem().toString(),
      // Add MCP-specific identifier
      'pingio-client',
    ];

    // Create a hash of the components
    const hash = crypto.createHash('sha256');
    hash.update(components.join('|'));
    this.fingerprint = hash.digest('base64url').slice(0, 32);

    return this.fingerprint;
  }

  /**
   * Get a user-friendly device name
   */
  getDeviceName(): string {
    if (this.deviceName) {
      return this.deviceName;
    }

    const platform = os.platform();
    const hostname = os.hostname();

    // Create a friendly name based on platform
    let platformName: string;
    switch (platform) {
      case 'darwin':
        platformName = 'Mac';
        break;
      case 'win32':
        platformName = 'Windows';
        break;
      case 'linux':
        platformName = 'Linux';
        break;
      default:
        platformName = platform;
    }

    this.deviceName = `${platformName} - ${hostname}`;
    return this.deviceName;
  }

  /**
   * Get both fingerprint and device name
   */
  getDeviceInfo(): DeviceFingerprint {
    return {
      fingerprint: this.getFingerprint(),
      deviceName: this.getDeviceName(),
    };
  }

  /**
   * Clear cached fingerprint (useful for testing)
   */
  clearCache(): void {
    this.fingerprint = null;
    this.deviceName = null;
  }
}

export const deviceService = new DeviceService();
