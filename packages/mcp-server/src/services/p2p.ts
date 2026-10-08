import { EventEmitter } from 'events';
import type { P2PConnection, DiscoveredPeer } from '../types/index.js';

// Simplified P2P service - uses WebRTC for browser/Node.js
// In production, would use node-datachannel for native WebRTC

export interface P2PServiceEvents {
  'peer:discovered': (peer: DiscoveredPeer) => void;
  'peer:lost': (userId: string) => void;
  'connection:ready': (connection: P2PConnection) => void;
  'connection:failed': (connectionId: string, error: Error) => void;
  'data:received': (connectionId: string, data: unknown) => void;
}

export class P2PService extends EventEmitter {
  private connections: Map<string, P2PConnection> = new Map();
  private discoveredPeers: Map<string, DiscoveredPeer> = new Map();
  private localUserId: string | null = null;
  private localUsername: string | null = null;
  private isInitialized = false;

  constructor() {
    super();
  }

  async initialize(userId: string, username: string): Promise<boolean> {
    this.localUserId = userId;
    this.localUsername = username;
    this.isInitialized = true;

    // Note: Full mDNS discovery requires bonjour-service
    // For MVP, we'll rely on cloud relay for peer discovery
    // P2P is used only when both parties are on same network and use cloud relay signaling

    return true;
  }

  async discoverPeers(): Promise<DiscoveredPeer[]> {
    // In MVP, peer discovery is done via cloud relay
    // Local network discovery would be implemented with mDNS
    return Array.from(this.discoveredPeers.values());
  }

  async createConnection(peerUserId: string, peerUsername: string): Promise<P2PConnection> {
    const connectionId = `${this.localUserId}_${peerUserId}_${Date.now()}`;

    const connection: P2PConnection = {
      connectionId,
      peerUserId,
      peerUsername,
      state: 'connecting',
      lastActivity: new Date(),
    };

    this.connections.set(connectionId, connection);

    // Note: Full WebRTC implementation requires RTCPeerConnection
    // For MVP, this is a stub that can be expanded

    return connection;
  }

  async acceptConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    connection.state = 'connected';
    connection.lastActivity = new Date();
    this.emit('connection:ready', connection);
  }

  async rejectConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.state = 'disconnected';
      this.connections.delete(connectionId);
    }
  }

  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.state = 'disconnected';
      this.connections.delete(connectionId);
    }
  }

  getConnection(connectionId: string): P2PConnection | undefined {
    return this.connections.get(connectionId);
  }

  getAllConnections(): P2PConnection[] {
    return Array.from(this.connections.values());
  }

  getActiveConnections(): P2PConnection[] {
    return Array.from(this.connections.values()).filter(
      (c) => c.state === 'connected'
    );
  }

  sendData(connectionId: string, data: unknown): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.state !== 'connected') {
      return false;
    }

    connection.lastActivity = new Date();
    // In full implementation, send via data channel
    return true;
  }

  shutdown(): void {
    for (const connection of this.connections.values()) {
      connection.state = 'disconnected';
    }
    this.connections.clear();
    this.discoveredPeers.clear();
    this.isInitialized = false;
  }

  isPeerAvailable(userId: string): boolean {
    const peer = this.discoveredPeers.get(userId);
    if (!peer) return false;

    // Check if peer was seen recently (within 60 seconds)
    const age = Date.now() - peer.lastSeen.getTime();
    return age < 60000;
  }
}

export const p2pService = new P2PService();
