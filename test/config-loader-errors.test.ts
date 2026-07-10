import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { DefaultConfigurationLoader } from '../src/config/workspace-config';
import { existsSync } from 'fs';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigurationLoader - Error Handling and Logging', () => {
  let testDir: string;
  let originalExit: typeof process.exit;
  let originalConsoleError: typeof console.error;
  let originalConsoleWarn: typeof console.warn;
  let exitCode: number | null = null;
  let errorLogs: string[] = [];
  let warnLogs: string[] = [];

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `agenthq-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Mock process.exit to capture exit calls
    exitCode = null;
    originalExit = process.exit;
    (process as any).exit = mock((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`Process.exit called with code ${code}`);
    });

    // Mock console.error and console.warn to capture logs
    errorLogs = [];
    warnLogs = [];
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    (console as any).error = mock((...args: any[]) => {
      errorLogs.push(args.join(' '));
    });
    (console as any).warn = mock((...args: any[]) => {
      warnLogs.push(args.join(' '));
    });
  });

  afterEach(async () => {
    // Restore original functions
    process.exit = originalExit;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;

    // Clean up test files
    try {
      await unlink(join(testDir, 'workspaces.json'));
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('Missing workspaces.json file', () => {
    it('should log descriptive error for missing file and exit with non-zero code', async () => {
      const nonExistentPath = join(testDir, 'non-existent-workspaces.json');
      const loader = new DefaultConfigurationLoader(nonExistentPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        // Expect process.exit to be called
        expect(exitCode).toBe(1);
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('Configuration file not found');
        expect(errorLogs[0]).toContain(nonExistentPath);
      }
    });
  });

  describe('Malformed JSON', () => {
    it('should log descriptive error with parse error details and exit', async () => {
      const configPath = join(testDir, 'workspaces.json');
      await writeFile(configPath, '{ invalid json: [ }', 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('Failed to parse configuration file');
        expect(errorLogs[0]).toContain('JSON parse error');
      }
    });
  });

  describe('Duplicate workspace IDs', () => {
    it('should log descriptive error for duplicate IDs and exit', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'duplicate-id',
            OUTPUT_DIR: '/path/to/output1',
            SESSIONS_DIR: '/path/to/sessions1',
            WORKSPACE_ROOT: '/path/to/root1',
          },
          {
            id: 'duplicate-id',
            OUTPUT_DIR: '/path/to/output2',
            SESSIONS_DIR: '/path/to/sessions2',
            WORKSPACE_ROOT: '/path/to/root2',
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error: any) {
        expect(exitCode).toBe(1);
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('Duplicate workspace IDs detected');
        expect(errorLogs[0]).toContain('duplicate-id');
      }
    });

    it('should handle multiple duplicate IDs', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'dup-a',
            OUTPUT_DIR: '/path/to/output1',
            SESSIONS_DIR: '/path/to/sessions1',
            WORKSPACE_ROOT: '/path/to/root1',
          },
          {
            id: 'dup-a',
            OUTPUT_DIR: '/path/to/output2',
            SESSIONS_DIR: '/path/to/sessions2',
            WORKSPACE_ROOT: '/path/to/root2',
          },
          {
            id: 'dup-b',
            OUTPUT_DIR: '/path/to/output3',
            SESSIONS_DIR: '/path/to/sessions3',
            WORKSPACE_ROOT: '/path/to/root3',
          },
          {
            id: 'dup-b',
            OUTPUT_DIR: '/path/to/output4',
            SESSIONS_DIR: '/path/to/sessions4',
            WORKSPACE_ROOT: '/path/to/root4',
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs[0]).toContain('Duplicate workspace IDs detected');
        expect(errorLogs[0]).toContain('dup-a');
        expect(errorLogs[0]).toContain('dup-b');
      }
    });
  });

  describe('Maximum workspace limit', () => {
    it('should log descriptive error for >50 workspaces and exit', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const workspaces = [];
      for (let i = 1; i <= 51; i++) {
        workspaces.push({
          id: `workspace-${i}`,
          OUTPUT_DIR: `/path/to/output${i}`,
          SESSIONS_DIR: `/path/to/sessions${i}`,
          WORKSPACE_ROOT: `/path/to/root${i}`,
        });
      }
      const config = { workspaces };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('exceeds maximum workspace limit');
        expect(errorLogs[0]).toContain('51');
        expect(errorLogs[0]).toContain('50');
      }
    });
  });

  describe('Non-existent required paths', () => {
    it('should log descriptive warning for non-existent OUTPUT_DIR, skip workspace, continue', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'invalid-workspace',
            OUTPUT_DIR: '/non/existent/output',
            SESSIONS_DIR: '/non/existent/sessions',
            WORKSPACE_ROOT: '/non/existent/root',
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      // Per Requirement 9.8: runtime conditions (path validation failures) should continue with warning
      const result = await loader.loadWorkspaces();
      
      // Should log warnings for missing paths
      expect(warnLogs.length).toBeGreaterThanOrEqual(2);
      expect(warnLogs.some(log => log.includes('WARNING'))).toBe(true);
      expect(warnLogs.some(log => log.includes('invalid-workspace'))).toBe(true);
      expect(warnLogs.some(log => log.includes('required path'))).toBe(true);
      expect(warnLogs.some(log => log.includes('does not exist'))).toBe(true);
      expect(warnLogs.some(log => log.includes('Skipping workspace'))).toBe(true);

      // Should return empty array and continue (Req 9.8 - runtime condition)
      expect(result.length).toBe(0);
      expect(exitCode).toBeNull();
      expect(warnLogs.some(log => log.includes('skipped due to path validation'))).toBe(true);
    });

    it('should skip invalid workspace but continue loading valid ones', async () => {
      // Create valid directories for second workspace
      const validOutput = join(testDir, 'valid-output');
      const validSessions = join(testDir, 'valid-sessions');
      const validRoot = join(testDir, 'valid-root');
      await mkdir(validOutput, { recursive: true });
      await mkdir(validSessions, { recursive: true });
      await mkdir(validRoot, { recursive: true });

      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'invalid-workspace',
            OUTPUT_DIR: '/non/existent/output',
            SESSIONS_DIR: '/non/existent/sessions',
            WORKSPACE_ROOT: '/non/existent/root',
          },
          {
            id: 'valid-workspace',
            OUTPUT_DIR: validOutput,
            SESSIONS_DIR: validSessions,
            WORKSPACE_ROOT: validRoot,
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      const result = await loader.loadWorkspaces();

      // Should have warnings for invalid workspace
      expect(warnLogs.some(log => log.includes('invalid-workspace'))).toBe(true);
      expect(warnLogs.some(log => log.includes('Skipping workspace'))).toBe(true);

      // Should successfully load valid workspace
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('valid-workspace');

      // Should NOT exit with error (valid workspace exists)
      expect(exitCode).toBeNull();
    });
  });

  describe('Zero valid workspaces after validation', () => {
    it('should log descriptive warning and return empty array when all workspaces are invalid', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'invalid-1',
            OUTPUT_DIR: '/non/existent/output1',
            SESSIONS_DIR: '/non/existent/sessions1',
            WORKSPACE_ROOT: '/non/existent/root1',
          },
          {
            id: 'invalid-2',
            OUTPUT_DIR: '/non/existent/output2',
            SESSIONS_DIR: '/non/existent/sessions2',
            WORKSPACE_ROOT: '/non/existent/root2',
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      // Per Requirement 9.8: runtime conditions should continue with warning
      const result = await loader.loadWorkspaces();

      // Should have warnings for each workspace
      expect(warnLogs.some(log => log.includes('invalid-1'))).toBe(true);
      expect(warnLogs.some(log => log.includes('invalid-2'))).toBe(true);

      // Should return empty array and NOT exit (Req 9.8)
      expect(result.length).toBe(0);
      expect(exitCode).toBeNull();
      expect(warnLogs.some(log => log.includes('skipped due to path validation'))).toBe(true);
    });
  });

  describe('Validation with workspace identifier in error messages', () => {
    it('should include workspace ID in validation error messages', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'test-workspace-123',
            OUTPUT_DIR: '', // Invalid: empty string
            SESSIONS_DIR: '/path/to/sessions',
            WORKSPACE_ROOT: '/path/to/root',
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('test-workspace-123');
        expect(errorLogs[0]).toContain('OUTPUT_DIR');
      }
    });
  });

  describe('validateWorkspace method', () => {
    it('should return false and log warning for non-existent OUTPUT_DIR', async () => {
      const loader = new DefaultConfigurationLoader();
      const config = {
        id: 'test-workspace',
        OUTPUT_DIR: '/non/existent/output',
        SESSIONS_DIR: testDir, // Use existing directory
        WORKSPACE_ROOT: testDir, // Use existing directory
      };

      const result = await loader.validateWorkspace(config);

      expect(result).toBe(false);
      expect(warnLogs.some(log => log.includes('WARNING'))).toBe(true);
      expect(warnLogs.some(log => log.includes('test-workspace'))).toBe(true);
      expect(warnLogs.some(log => log.includes('OUTPUT_DIR'))).toBe(true);
      expect(warnLogs.some(log => log.includes('does not exist'))).toBe(true);
    });

    it('should return false and log warning for non-existent SESSIONS_DIR', async () => {
      const loader = new DefaultConfigurationLoader();
      const config = {
        id: 'test-workspace',
        OUTPUT_DIR: testDir, // Use existing directory
        SESSIONS_DIR: '/non/existent/sessions',
        WORKSPACE_ROOT: testDir, // Use existing directory
      };

      const result = await loader.validateWorkspace(config);

      expect(result).toBe(false);
      expect(warnLogs.some(log => log.includes('SESSIONS_DIR'))).toBe(true);
    });

    it('should return false and log warning for non-existent WORKSPACE_ROOT', async () => {
      const loader = new DefaultConfigurationLoader();
      const config = {
        id: 'test-workspace',
        OUTPUT_DIR: testDir, // Use existing directory
        SESSIONS_DIR: testDir, // Use existing directory
        WORKSPACE_ROOT: '/non/existent/root',
      };

      const result = await loader.validateWorkspace(config);

      expect(result).toBe(false);
      expect(warnLogs.some(log => log.includes('WORKSPACE_ROOT'))).toBe(true);
    });

    it('should return true for valid paths', async () => {
      const loader = new DefaultConfigurationLoader();
      const config = {
        id: 'test-workspace',
        OUTPUT_DIR: testDir,
        SESSIONS_DIR: testDir,
        WORKSPACE_ROOT: testDir,
      };

      const result = await loader.validateWorkspace(config);

      expect(result).toBe(true);
      expect(warnLogs.length).toBe(0);
    });
  });
});
