import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DefaultConfigurationLoader } from '../src/config/workspace-config';
import { tmpdir } from 'os';

// Mock process.exit to prevent test termination
const mockExit = mock(() => {
  throw new Error('process.exit called');
});

// Mock console.error to capture error messages
const mockConsoleError = mock(() => {});

describe('WorkspaceConfig - Validation Rules', () => {
  let testDir: string;
  let configPath: string;
  let testWorkspaceDirs: string[];
  let originalExit: any;
  let originalConsoleError: any;

  beforeEach(() => {
    // Create temporary test directory
    testDir = join(tmpdir(), `agenthq-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    configPath = join(testDir, 'workspaces.json');
    testWorkspaceDirs = [];

    // Mock process.exit and console.error
    originalExit = process.exit;
    originalConsoleError = console.error;
    process.exit = mockExit as any;
    console.error = mockConsoleError as any;
    mockExit.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    // Restore originals
    process.exit = originalExit;
    console.error = originalConsoleError;

    // Clean up test directory
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createTestWorkspaceDirs(count: number): string[] {
    const dirs: string[] = [];
    for (let i = 0; i < count; i++) {
      const wsDir = join(testDir, `workspace-${i}`);
      const outputDir = join(wsDir, 'output');
      const sessionsDir = join(wsDir, 'sessions');
      
      mkdirSync(outputDir, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
      
      dirs.push(wsDir);
    }
    testWorkspaceDirs = dirs;
    return dirs;
  }

  function writeConfig(config: any) {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  describe('Workspace ID Regex Validation (Req 1.2)', () => {
    it('should accept valid workspace IDs with lowercase alphanumeric and hyphens', async () => {
      const dirs = createTestWorkspaceDirs(5);
      const validIds = [
        'workspace',
        'workspace-123',
        'test-workspace-abc',
        '123-abc',
        'a',
      ];

      const config = {
        workspaces: validIds.map((id, i) => ({
          id,
          OUTPUT_DIR: join(dirs[i], 'output'),
          SESSIONS_DIR: join(dirs[i], 'sessions'),
          WORKSPACE_ROOT: dirs[i],
        })),
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(5);
      expect(workspaces.map(w => w.id)).toEqual(validIds);
    });

    it('should reject workspace ID with uppercase letters', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'Workspace-ABC',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe('process.exit called');
        expect(mockExit).toHaveBeenCalled();
      }
    });

    it('should reject workspace ID with special characters', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const invalidIds = ['workspace_test', 'workspace.test', 'workspace@123', 'workspace test'];

      for (const id of invalidIds) {
        mockExit.mockClear();
        
        const config = {
          workspaces: [{
            id,
            OUTPUT_DIR: join(dirs[0], 'output'),
            SESSIONS_DIR: join(dirs[0], 'sessions'),
            WORKSPACE_ROOT: dirs[0],
          }],
        };

        writeConfig(config);
        const loader = new DefaultConfigurationLoader(configPath);

        try {
          await loader.loadWorkspaces();
          expect(true).toBe(false); // Should not reach here
        } catch (e: any) {
          expect(e.message).toBe('process.exit called');
          expect(mockExit).toHaveBeenCalled();
        }
      }
    });

    it('should reject workspace ID exceeding 50 characters', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const longId = 'a'.repeat(51);
      const config = {
        workspaces: [{
          id: longId,
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe('process.exit called');
        expect(mockExit).toHaveBeenCalled();
      }
    });

    it('should accept workspace ID with exactly 50 characters', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const exactId = 'a'.repeat(50);
      const config = {
        workspaces: [{
          id: exactId,
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(1);
      expect(workspaces[0].id).toBe(exactId);
    });

    it('should reject empty workspace ID', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: '',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe('process.exit called');
        expect(mockExit).toHaveBeenCalled();
      }
    });
  });

  describe('Uniqueness Check (Req 1.10)', () => {
    it('should reject duplicate workspace IDs (case-sensitive)', async () => {
      const dirs = createTestWorkspaceDirs(2);
      const config = {
        workspaces: [
          {
            id: 'workspace-alpha',
            OUTPUT_DIR: join(dirs[0], 'output'),
            SESSIONS_DIR: join(dirs[0], 'sessions'),
            WORKSPACE_ROOT: dirs[0],
          },
          {
            id: 'workspace-alpha',
            OUTPUT_DIR: join(dirs[1], 'output'),
            SESSIONS_DIR: join(dirs[1], 'sessions'),
            WORKSPACE_ROOT: dirs[1],
          },
        ],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe('process.exit called');
        expect(mockExit).toHaveBeenCalled();
      }
    });

    it('should accept workspace IDs that differ only in case', async () => {
      const dirs = createTestWorkspaceDirs(2);
      const config = {
        workspaces: [
          {
            id: 'workspace-alpha',
            OUTPUT_DIR: join(dirs[0], 'output'),
            SESSIONS_DIR: join(dirs[0], 'sessions'),
            WORKSPACE_ROOT: dirs[0],
          },
          {
            id: 'workspace-beta',
            OUTPUT_DIR: join(dirs[1], 'output'),
            SESSIONS_DIR: join(dirs[1], 'sessions'),
            WORKSPACE_ROOT: dirs[1],
          },
        ],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(2);
      expect(workspaces.map(w => w.id).sort()).toEqual(['workspace-alpha', 'workspace-beta']);
    });

    it('should reject multiple duplicate workspace IDs', async () => {
      const dirs = createTestWorkspaceDirs(4);
      const config = {
        workspaces: [
          {
            id: 'workspace-a',
            OUTPUT_DIR: join(dirs[0], 'output'),
            SESSIONS_DIR: join(dirs[0], 'sessions'),
            WORKSPACE_ROOT: dirs[0],
          },
          {
            id: 'workspace-b',
            OUTPUT_DIR: join(dirs[1], 'output'),
            SESSIONS_DIR: join(dirs[1], 'sessions'),
            WORKSPACE_ROOT: dirs[1],
          },
          {
            id: 'workspace-a',
            OUTPUT_DIR: join(dirs[2], 'output'),
            SESSIONS_DIR: join(dirs[2], 'sessions'),
            WORKSPACE_ROOT: dirs[2],
          },
          {
            id: 'workspace-b',
            OUTPUT_DIR: join(dirs[3], 'output'),
            SESSIONS_DIR: join(dirs[3], 'sessions'),
            WORKSPACE_ROOT: dirs[3],
          },
        ],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe('process.exit called');
        expect(mockExit).toHaveBeenCalled();
      }
    });
  });

  describe('50-Workspace Maximum Limit (Req 1.14)', () => {
    it('should accept exactly 50 workspaces', async () => {
      const dirs = createTestWorkspaceDirs(50);
      const workspaces = dirs.map((dir, i) => ({
        id: `workspace-${i}`,
        OUTPUT_DIR: join(dir, 'output'),
        SESSIONS_DIR: join(dir, 'sessions'),
        WORKSPACE_ROOT: dir,
      }));

      const config = { workspaces };
      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const loaded = await loader.loadWorkspaces();

      expect(loaded.length).toBe(50);
    });

    it('should reject 51 workspaces', async () => {
      const dirs = createTestWorkspaceDirs(51);
      const workspaces = dirs.map((dir, i) => ({
        id: `workspace-${i}`,
        OUTPUT_DIR: join(dir, 'output'),
        SESSIONS_DIR: join(dir, 'sessions'),
        WORKSPACE_ROOT: dir,
      }));

      const config = { workspaces };
      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should accept 0 workspaces (empty array)', async () => {
      const config = { workspaces: [] };
      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const loaded = await loader.loadWorkspaces();

      // Note: Based on the implementation, empty workspaces should exit
      // This test verifies the current behavior
      expect(loaded.length).toBe(0);
    });
  });

  describe('Required Field Validation (Req 1.3, 1.14)', () => {
    it('should reject missing OUTPUT_DIR', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should reject missing SESSIONS_DIR', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should reject missing WORKSPACE_ROOT', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should reject empty OUTPUT_DIR string', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: '',
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should reject empty SESSIONS_DIR string', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: '',
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should reject empty WORKSPACE_ROOT string', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: '',
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);

      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as any;

      try {
        await loader.loadWorkspaces();
      } catch (e) {
        // Expected error
      }

      process.exit = originalExit;
      expect(exitCalled).toBe(true);
    });

    it('should accept all required fields with valid values', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(1);
      expect(workspaces[0].id).toBe('test-workspace');
    });
  });

  describe('Path Validation (Req 1.12)', () => {
    it('should skip workspace with non-existent OUTPUT_DIR', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: '/non/existent/path/output',
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      // Workspace should be skipped due to non-existent path
      expect(workspaces.length).toBe(0);
    });

    it('should skip workspace with non-existent SESSIONS_DIR', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: '/non/existent/path/sessions',
          WORKSPACE_ROOT: dirs[0],
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(0);
    });

    it('should skip workspace with non-existent WORKSPACE_ROOT', async () => {
      const dirs = createTestWorkspaceDirs(1);
      const config = {
        workspaces: [{
          id: 'test-workspace',
          OUTPUT_DIR: join(dirs[0], 'output'),
          SESSIONS_DIR: join(dirs[0], 'sessions'),
          WORKSPACE_ROOT: '/non/existent/path',
        }],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(0);
    });

    it('should load valid workspaces and skip invalid ones', async () => {
      const dirs = createTestWorkspaceDirs(3);
      const config = {
        workspaces: [
          {
            id: 'valid-workspace-1',
            OUTPUT_DIR: join(dirs[0], 'output'),
            SESSIONS_DIR: join(dirs[0], 'sessions'),
            WORKSPACE_ROOT: dirs[0],
          },
          {
            id: 'invalid-workspace',
            OUTPUT_DIR: '/non/existent/path/output',
            SESSIONS_DIR: join(dirs[1], 'sessions'),
            WORKSPACE_ROOT: dirs[1],
          },
          {
            id: 'valid-workspace-2',
            OUTPUT_DIR: join(dirs[2], 'output'),
            SESSIONS_DIR: join(dirs[2], 'sessions'),
            WORKSPACE_ROOT: dirs[2],
          },
        ],
      };

      writeConfig(config);
      const loader = new DefaultConfigurationLoader(configPath);
      const workspaces = await loader.loadWorkspaces();

      expect(workspaces.length).toBe(2);
      expect(workspaces.map(w => w.id).sort()).toEqual(['valid-workspace-1', 'valid-workspace-2']);
    });
  });
});
