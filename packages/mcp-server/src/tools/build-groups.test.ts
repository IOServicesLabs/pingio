import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getEffectiveRelayUrl: vi.fn(() => 'ws://localhost:3000/ws'),
    getRestBaseUrl: vi.fn(() => 'http://localhost:3000'),
  },
}));

vi.mock('../services/relay.js', () => ({
  relayClient: {
    sendSessionStatusReport: vi.fn(),
    sendContextClearRequest: vi.fn(),
    sendContextClearAck: vi.fn(),
    sendBuildTaskComplete: vi.fn(),
    sendBuildArtifactPayload: vi.fn(),
    sendBuildArtifactRequest: vi.fn(),
    sendBuildArtifactClearRequest: vi.fn(),
    sendBuildArtifactCleared: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

const mockAxiosPost = vi.fn();
const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
    isAxiosError: vi.fn((e: any) => e?.isAxiosError === true),
  },
}));

describe('Build group tools', () => {
  let configManager: any;
  let relayClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configMod = await import('../config.js');
    configManager = configMod.configManager;
    const relayMod = await import('../services/relay.js');
    relayClient = relayMod.relayClient;

    configManager.getConfig.mockReturnValue({
      identity: { authToken: 'test-token', userId: 'u1', username: 'alice' },
    });
  });

  describe('createBuildTask', () => {
    it('calls POST /api/channels/:id/build/tasks', async () => {
      mockAxiosPost.mockResolvedValue({ data: { task: { id: 'task-1', title: 'Build' } } });

      const { createBuildTask } = await import('./build-groups.js');
      const result = await createBuildTask('ch-1', 'Build', 'desc');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/build/tasks',
        { title: 'Build', description: 'desc' },
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ task task-1 created');
    });
  });

  describe('assignBuildTask', () => {
    it('calls POST /api/channels/:id/build/tasks/:taskId/assign', async () => {
      mockAxiosPost.mockResolvedValue({ data: { task: { id: 'task-1', assignedTo: 'u2' } } });

      const { assignBuildTask } = await import('./build-groups.js');
      const result = await assignBuildTask('ch-1', 'task-1', 'bob');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/build/tasks/task-1/assign',
        { username: 'bob' },
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ task task-1 assigned to @bob');
    });
  });

  describe('getBuildTasks', () => {
    it('calls GET /api/channels/:id/build/tasks', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          tasks: [
            { id: 'task-1', title: 'Build', status: 'pending' },
            { id: 'task-2', title: 'Test', status: 'completed', assignedTo: 'u2' },
          ],
        },
      });

      const { getBuildTasks } = await import('./build-groups.js');
      const result = await getBuildTasks('ch-1');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/build/tasks',
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('[pending] Build');
    });
  });

  describe('completeBuildTask', () => {
    it('calls POST /api/channels/:id/build/tasks/:taskId/complete', async () => {
      mockAxiosPost.mockResolvedValue({ data: { task: { id: 'task-1', status: 'completed' } } });

      const { completeBuildTask } = await import('./build-groups.js');
      const result = await completeBuildTask('ch-1', 'task-1', 'out.zip', 1234);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/build/tasks/task-1/complete',
        { artifactFilename: 'out.zip', artifactSize: 1234 },
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ task task-1 completed');
    });
  });

  describe('getMemberStatuses', () => {
    it('calls GET /api/channels/:id/members/status', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          statuses: [
            { userId: 'u1', remainingRequests: 50, contextWindowUsed: 100, selectedModel: 'sonnet' },
          ],
        },
      });

      const { getMemberStatuses } = await import('./build-groups.js');
      const result = await getMemberStatuses('ch-1');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/members/status',
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('remaining=50');
    });
  });

  describe('reportSessionStatus', () => {
    it('sends session_status_report over WebSocket', async () => {
      const { reportSessionStatus } = await import('./build-groups.js');
      const result = await reportSessionStatus('ch-1', 50, 100, 'sonnet');

      expect(relayClient.sendSessionStatusReport).toHaveBeenCalledWith('ch-1', {
        remainingRequests: 50,
        contextWindowUsed: 100,
        selectedModel: 'sonnet',
      });
      expect(result.content[0].text).toBe('✓ status reported');
    });
  });

  describe('requestContextClear', () => {
    it('sends context_clear_request over WebSocket', async () => {
      const { requestContextClear } = await import('./build-groups.js');
      const result = await requestContextClear('ch-1', 'bob', 'task-1');

      expect(relayClient.sendContextClearRequest).toHaveBeenCalledWith('ch-1', 'task-1', 'bob');
      expect(result.content[0].text).toBe('✓ asked @bob to clear context');
    });
  });

  describe('acknowledgeContextClear', () => {
    it('sends context_clear_ack over WebSocket', async () => {
      const { acknowledgeContextClear } = await import('./build-groups.js');
      const result = await acknowledgeContextClear('ch-1', 'task-1');

      expect(relayClient.sendContextClearAck).toHaveBeenCalledWith('ch-1', 'task-1');
      expect(result.content[0].text).toBe('✓ context clear acknowledged');
    });
  });

  describe('uploadArtifact', () => {
    it('copies file to local artifact dir and emits completion', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const artifactDir = path.join(os.tmpdir(), `pingio-artifacts-${Date.now()}`);
      process.env.LOCAL_ARTIFACT_DIR = artifactDir;
      const tmpFile = path.join(os.tmpdir(), `pingio-upload-test-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, 'hello artifact');

      const { uploadArtifact } = await import('./build-groups.js');
      const result = await uploadArtifact('ch-1', 'task-1', tmpFile);

      expect(relayClient.sendBuildTaskComplete).toHaveBeenCalledWith('ch-1', 'task-1', path.basename(tmpFile), 14);
      expect(result.content[0].text).toContain('uploaded');

      fs.unlinkSync(tmpFile);
      fs.rmSync(artifactDir, { recursive: true, force: true });
      delete process.env.LOCAL_ARTIFACT_DIR;
    });
  });

  describe('sendArtifactPayload', () => {
    it('sends base64 artifact payload', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const artifactDir = path.join(os.tmpdir(), `pingio-artifacts-${Date.now()}`);
      process.env.LOCAL_ARTIFACT_DIR = artifactDir;
      const dir = path.join(artifactDir, 'ch-1', 'task-1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'out.txt'), 'payload');

      const { sendArtifactPayload } = await import('./build-groups.js');
      const result = await sendArtifactPayload('ch-1', 'task-1', 'out.txt');

      expect(relayClient.sendBuildArtifactPayload).toHaveBeenCalledWith(
        'ch-1',
        'task-1',
        'out.txt',
        Buffer.from('payload').toString('base64')
      );
      expect(result.content[0].text).toContain('sent');

      fs.rmSync(artifactDir, { recursive: true, force: true });
      delete process.env.LOCAL_ARTIFACT_DIR;
    });
  });

  describe('downloadArtifact', () => {
    it('requests artifact and writes payload when received', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const outputDir = path.join(os.tmpdir(), `pingio-dl-${Date.now()}`);

      relayClient.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'build:artifact_payload') {
          setTimeout(() => {
            handler({ channelId: 'ch-1', taskId: 'task-1', filename: 'down.txt', data: Buffer.from('downloaded').toString('base64') });
          }, 10);
        }
      });

      const { downloadArtifact } = await import('./build-groups.js');
      const result = await downloadArtifact('ch-1', 'task-1', outputDir);

      expect(relayClient.sendBuildArtifactRequest).toHaveBeenCalledWith('ch-1', 'task-1');
      expect(result.content[0].text).toContain('downloaded');
      expect(fs.existsSync(path.join(outputDir, 'down.txt'))).toBe(true);

      fs.rmSync(outputDir, { recursive: true, force: true });
    });
  });

  describe('artifact security', () => {
    it('sendArtifactPayload rejects a path-traversal filename', async () => {
      const { sendArtifactPayload } = await import('./build-groups.js');
      const result = await sendArtifactPayload('ch-1', 'task-1', '../../secret.txt');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid artifact filename');
      expect(relayClient.sendBuildArtifactPayload).not.toHaveBeenCalled();
    });

    it('clearLocalArtifact rejects a path-traversal filename', async () => {
      const { clearLocalArtifact } = await import('./build-groups.js');
      const result = await clearLocalArtifact('ch-1', 'task-1', '..\\..\\evil');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid artifact filename');
    });

    it('downloadArtifact ignores a poisoned traversal payload and writes the safe one', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const outputDir = path.join(os.tmpdir(), `pingio-dl-sec-${Date.now()}`);

      relayClient.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'build:artifact_payload') {
          // Attacker races a traversal filename first...
          setTimeout(() => {
            handler({ channelId: 'ch-1', taskId: 'task-1', filename: '../escape.txt', data: Buffer.from('evil').toString('base64') });
          }, 5);
          // ...then the legitimate worker delivers a safe basename.
          setTimeout(() => {
            handler({ channelId: 'ch-1', taskId: 'task-1', filename: 'result.md', data: Buffer.from('safe').toString('base64') });
          }, 20);
        }
      });

      const { downloadArtifact } = await import('./build-groups.js');
      const result = await downloadArtifact('ch-1', 'task-1', outputDir);

      expect(result.content[0].text).toContain('result.md');
      expect(fs.existsSync(path.join(outputDir, 'result.md'))).toBe(true);
      // The traversal target (parent of outputDir) must never be written.
      expect(fs.existsSync(path.join(outputDir, '..', 'escape.txt'))).toBe(false);

      fs.rmSync(outputDir, { recursive: true, force: true });
    });

    it('downloadArtifact ignores an oversized payload and writes the in-limit one', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const outputDir = path.join(os.tmpdir(), `pingio-dl-size-${Date.now()}`);
      process.env.MAX_ARTIFACT_MESSAGE_SIZE = '4'; // 4 bytes decoded

      relayClient.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'build:artifact_payload') {
          setTimeout(() => {
            handler({ channelId: 'ch-1', taskId: 'task-1', filename: 'big.bin', data: Buffer.from('way too large').toString('base64') });
          }, 5);
          setTimeout(() => {
            handler({ channelId: 'ch-1', taskId: 'task-1', filename: 'ok.bin', data: Buffer.from('hi').toString('base64') });
          }, 20);
        }
      });

      const { downloadArtifact } = await import('./build-groups.js');
      const result = await downloadArtifact('ch-1', 'task-1', outputDir);

      expect(result.content[0].text).toContain('ok.bin');
      expect(fs.existsSync(path.join(outputDir, 'ok.bin'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'big.bin'))).toBe(false);

      fs.rmSync(outputDir, { recursive: true, force: true });
      delete process.env.MAX_ARTIFACT_MESSAGE_SIZE;
    });
  });

  describe('clearWorkerArtifact', () => {
    it('sends artifact clear request', async () => {
      const { clearWorkerArtifact } = await import('./build-groups.js');
      const result = await clearWorkerArtifact('ch-1', 'task-1');

      expect(relayClient.sendBuildArtifactClearRequest).toHaveBeenCalledWith('ch-1', 'task-1');
      expect(result.content[0].text).toBe('✓ asked worker to clear artifact');
    });
  });

  describe('clearLocalArtifact', () => {
    it('removes local artifact dir and notifies owner', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const artifactDir = path.join(os.tmpdir(), `pingio-artifacts-${Date.now()}`);
      process.env.LOCAL_ARTIFACT_DIR = artifactDir;
      const dir = path.join(artifactDir, 'ch-1', 'task-1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'out.txt'), 'data');

      const { clearLocalArtifact } = await import('./build-groups.js');
      const result = await clearLocalArtifact('ch-1', 'task-1');

      expect(fs.existsSync(dir)).toBe(false);
      expect(relayClient.sendBuildArtifactCleared).toHaveBeenCalledWith('ch-1', 'task-1');
      expect(result.content[0].text).toBe('✓ local artifact cleared');

      fs.rmSync(artifactDir, { recursive: true, force: true });
      delete process.env.LOCAL_ARTIFACT_DIR;
    });
  });
});
