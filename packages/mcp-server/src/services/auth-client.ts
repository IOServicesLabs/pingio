import axios from 'axios';
import { configManager } from '../config.js';
import { getDeviceFingerprint, getDeviceName } from '../tools/devices.js';

export interface AuthResponse {
  success: boolean;
  userId?: string;
  token?: string;
  refreshToken?: string;
  deviceId?: string;
  user?: { id: string; username: string; displayName?: string };
  error?: string;
  verificationRequired?: boolean;
  suggestions?: string[];
}

function getAuthUrl(): string {
  return configManager.getAuthBaseUrl();
}

export async function registerUser(
  username: string,
  password: string,
  displayName?: string
): Promise<AuthResponse> {
  const authUrl = getAuthUrl();
  const deviceFingerprint = getDeviceFingerprint();
  const deviceName = getDeviceName();

  const isCloud = configManager.getConfig().mode !== 'self-hosted';
  const endpoint = isCloud ? `${authUrl}/oauth/register` : `${authUrl}/api/auth/register`;

  try {
    const response = await axios.post(endpoint, {
      username,
      password,
      displayName,
      deviceFingerprint,
      deviceName,
    });
    return response.data as AuthResponse;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data as AuthResponse;
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const authUrl = getAuthUrl();
  const deviceFingerprint = getDeviceFingerprint();
  const deviceName = getDeviceName();

  const isCloud = configManager.getConfig().mode !== 'self-hosted';
  const endpoint = isCloud ? `${authUrl}/oauth/login` : `${authUrl}/api/auth/login`;

  try {
    const response = await axios.post(endpoint, {
      username,
      password,
      deviceFingerprint,
      deviceName,
    });
    return response.data as AuthResponse;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data as AuthResponse;
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function refreshToken(refreshToken: string): Promise<AuthResponse> {
  const authUrl = getAuthUrl();
  const deviceFingerprint = getDeviceFingerprint();

  const isCloud = configManager.getConfig().mode !== 'self-hosted';
  const endpoint = isCloud ? `${authUrl}/oauth/refresh` : `${authUrl}/api/auth/refresh`;

  try {
    const response = await axios.post(endpoint, {
      refreshToken,
      deviceFingerprint,
    });
    return response.data as AuthResponse;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data as AuthResponse;
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function listDevices(token: string): Promise<{
  success: boolean;
  devices?: Array<{
    id: string;
    deviceName?: string;
    lastSeen?: Date;
    isVerified: boolean;
    isCurrent: boolean;
  }>;
  error?: string;
}> {
  const authUrl = getAuthUrl();
  const isCloud = configManager.getConfig().mode !== 'self-hosted';
  const endpoint = isCloud ? `${authUrl}/oauth/devices` : `${authUrl}/api/devices`;

  try {
    const response = await axios.get(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data;
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function verifyDevice(token: string, deviceId: string): Promise<{ success: boolean; error?: string }> {
  const authUrl = getAuthUrl();
  const isCloud = configManager.getConfig().mode !== 'self-hosted';
  const endpoint = isCloud ? `${authUrl}/oauth/devices/verify` : `${authUrl}/api/devices/verify`;

  try {
    const response = await axios.post(
      endpoint,
      { deviceId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data;
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function revokeDevice(token: string, deviceId: string): Promise<{ success: boolean; error?: string }> {
  const authUrl = getAuthUrl();
  const isCloud = configManager.getConfig().mode !== 'self-hosted';
  const endpoint = isCloud ? `${authUrl}/oauth/devices/revoke` : `${authUrl}/api/devices/revoke`;

  try {
    const response = await axios.post(
      endpoint,
      { deviceId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data;
    }
    return { success: false, error: (error as Error).message };
  }
}

export interface SsoProviderInfo {
  slug: string;
  name: string;
}

function ssoUnsupported(): { success: false; error: string } {
  return {
    success: false,
    error: 'SSO login is only available in cloud mode (against a central auth server)',
  };
}

export async function listSsoProviders(): Promise<{
  success: boolean;
  providers?: SsoProviderInfo[];
  error?: string;
}> {
  if (configManager.getConfig().mode === 'self-hosted') {
    return ssoUnsupported();
  }

  try {
    const response = await axios.get(`${getAuthUrl()}/oauth/sso/providers`);
    return { success: true, providers: response.data.providers as SsoProviderInfo[] };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return { success: false, error: (error.response.data as { error?: string }).error || 'Failed to list SSO providers' };
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function startSsoLogin(slug: string): Promise<{
  success: boolean;
  authorizeUrl?: string;
  expiresAt?: string;
  error?: string;
}> {
  if (configManager.getConfig().mode === 'self-hosted') {
    return ssoUnsupported();
  }

  try {
    const response = await axios.post(`${getAuthUrl()}/oauth/sso/start`, { slug });
    return response.data as { success: boolean; authorizeUrl?: string; expiresAt?: string };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data as { success: false; error: string };
    }
    return { success: false, error: (error as Error).message };
  }
}

export async function completeSsoLogin(code: string): Promise<AuthResponse & { username?: string }> {
  if (configManager.getConfig().mode === 'self-hosted') {
    return ssoUnsupported();
  }

  const deviceFingerprint = getDeviceFingerprint();
  const deviceName = getDeviceName();

  try {
    const response = await axios.post(`${getAuthUrl()}/oauth/sso/complete`, {
      code,
      deviceFingerprint,
      deviceName,
    });
    return response.data as AuthResponse & { username?: string };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      return error.response.data as AuthResponse;
    }
    return { success: false, error: (error as Error).message };
  }
}
