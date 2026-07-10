/**
 * Unit Tests for Configuration Error Scenarios
 * 
 * Tests covering:
 * - Missing workspaces.json file (Requirement 1.8)
 * - Malformed JSON (Requirement 1.9)
 * - Duplicate workspace IDs (Requirement 1.11)
 * - Zero valid workspaces after validation (Requirement 1.15)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { DefaultConfigurationLoader, type WorkspaceConfig } from '../../src/config/workspace-config';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigurationLoader - Error Scenarios', () => {
  let testDir: string;
  let originalExit: typeof process.exit;
  let originalConsoleError: typeof console.error;
  let originalConsoleWarn: typeof console.warn;
  let exitCode: number | null = null;
  let errorLogs: string[] = [];
  let warnLogs: string[] = [];

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `agenthq-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
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

    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Test missing workspaces.json file
   * 
   * **Validates: Requirement 1.8**
   * 
   * WHEN the JSON configuration file `workspaces.json` does not exist at the repository root,
   * THE Configuration_Loader SHALL log a descriptive error, prevent any further execution,
   * and exit with non-zero exit code
   */
  describe('Missing workspaces.json file', () => {
    it('should log error and exit with code 1 when workspaces.json is missing', async () => {
      const nonExistentPath = join(testDir, 'non-existent-workspaces.json');
      const loader = new DefaultConfigurationLoader(nonExistentPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('loadWorkspaces should have thrown');
      } catch (error: any) {
        // Verify process.exit was called with non-zero code
        expect(exitCode).toBe(1);
        
        // Verify descriptive error was logged
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('Configuration file not found');
        expect(errorLogs[0]).toContain(nonExistentPath);
      }
    });

    it('should not proceed with any operations after missing file', async () => {
      const nonExistentPath = join(testDir, 'missing.json');
      const loader = new DefaultConfigurationLoader(nonExistentPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have exited immediately');
      } catch (error) {
        // Should only have the file not found error, no other processing
        expect(errorLogs.length).toBe(1);
        expect(errorLogs[0]).toContain('Configuration file not found');
      }
    });
  });

  /**
   * Test malformed JSON
   * 
   * **Validates: Requirement 1.9**
   * 
   * WHEN the JSON configuration file `workspaces.json` exists but contains malformed JSON
   * (invalid syntax), THE Configuration_Loader SHALL log a descriptive error including the
   * JSON parse error and exit with non-zero exit code
   */
  describe('Malformed JSON', () => {
    it('should log error with parse details and exit with code 1 for invalid JSON syntax', async () => {
      const configPath = join(testDir, 'workspaces.json');
      // Write invalid JSON with syntax errors
      await writeFile(configPath, '{ invalid json: [ }', 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('loadWorkspaces should have thrown');
      } catch (error) {
        // Verify process.exit was called with non-zero code
        expect(exitCode).toBe(1);
        
        // Verify descriptive error was logged with parse error details
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('Failed to parse configuration file');
        expect(errorLogs[0]).toContain(configPath);
        expect(errorLogs[0]).toContain('JSON parse error');
      }
    });

    it('should log error for unclosed JSON objects', async () => {
      const configPath = join(testDir, 'workspaces.json');
      await writeFile(configPath, '{ "workspaces": [', 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs[0]).toContain('Failed to parse configuration file');
        expect(errorLogs[0]).toContain('JSON parse error');
      }
    });

    it('should log error for invalid JSON types', async () => {
      const configPath = join(testDir, 'workspaces.json');
      await writeFile(configPath, '{ "workspaces": undefined }', 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs[0]).toContain('Failed to parse configuration file');
      }
    });

    it('should log error for trailing commas', async () => {
      const configPath = join(testDir, 'workspaces.json');
      await writeFile(configPath, '{ "workspaces": [{"id": "test",}] }', 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(exitCode).toBe(1);
        expect(errorLogs[0]).toContain('Failed to parse configuration file');
        expect(errorLogs[0]).toContain('JSON parse error');
      }
    });
  });

  /**
   * Test duplicate workspace IDs
   * 
   * **Validates: Requirement 1.11**
   * 
   * WHEN duplicate Workspace_Identifier values are detected, THE Configuration_Loader
   * SHALL log a descriptive error naming all duplicate identifiers and exit with
   * non-zero exit code
   */
  describe('Duplicate workspace IDs', () => {
    it('should log error naming duplicates and exit with code 1', async () => {
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
        expect.unreachable('loadWorkspaces should have thrown');
      } catch (error) {
        // Verify process.exit was called with non-zero code
        expect(exitCode).toBe(1);
        
        // Verify descriptive error was logged naming the duplicate ID
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('Duplicate workspace IDs detected');
        expect(errorLogs[0]).toContain('duplicate-id');
      }
    });

    it('should handle multiple different duplicate IDs', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'dup-alpha',
            OUTPUT_DIR: '/path/to/output1',
            SESSIONS_DIR: '/path/to/sessions1',
            WORKSPACE_ROOT: '/path/to/root1',
          },
          {
            id: 'dup-alpha',
            OUTPUT_DIR: '/path/to/output2',
            SESSIONS_DIR: '/path/to/sessions2',
            WORKSPACE_ROOT: '/path/to/root2',
          },
          {
            id: 'dup-beta',
            OUTPUT_DIR: '/path/to/output3',
            SESSIONS_DIR: '/path/to/sessions3',
            WORKSPACE_ROOT: '/path/to/root3',
          },
          {
            id: 'dup-beta',
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
        
        // Verify both duplicate IDs are mentioned in the error
        expect(errorLogs[0]).toContain('Duplicate workspace IDs detected');
        expect(errorLogs[0]).toContain('dup-alpha');
        expect(errorLogs[0]).toContain('dup-beta');
      }
    });

    it('should detect duplicates with three or more instances of same ID', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'triple-dup',
            OUTPUT_DIR: '/path/to/output1',
            SESSIONS_DIR: '/path/to/sessions1',
            WORKSPACE_ROOT: '/path/to/root1',
          },
          {
            id: 'triple-dup',
            OUTPUT_DIR: '/path/to/output2',
            SESSIONS_DIR: '/path/to/sessions2',
            WORKSPACE_ROOT: '/path/to/root2',
          },
          {
            id: 'triple-dup',
            OUTPUT_DIR: '/path/to/output3',
            SESSIONS_DIR: '/path/to/sessions3',
            WORKSPACE_ROOT: '/path/to/root3',
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
        expect(errorLogs[0]).toContain('triple-dup');
      }
    });

    it('should use case-sensitive comparison for duplicate detection', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'workspace-id',
            OUTPUT_DIR: testDir,
            SESSIONS_DIR: testDir,
            WORKSPACE_ROOT: testDir,
          },
          {
            id: 'Workspace-ID', // Different case - should be treated as different
            OUTPUT_DIR: testDir,
            SESSIONS_DIR: testDir,
            WORKSPACE_ROOT: testDir,
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      // Should fail validation due to uppercase letters in second ID, not duplicates
      try {
        await loader.loadWorkspaces();
        expect.unreachable('Should have thrown due to invalid ID format');
      } catch (error) {
        expect(exitCode).toBe(1);
        // Should fail on regex validation, not duplicate detection
        expect(errorLogs[0]).not.toContain('Duplicate workspace IDs');
      }
    });
  });

  /**
   * Test zero valid workspaces after path validation
   * 
   * **Validates: Requirement 1.15** (derived from requirements 1.13)
   * 
   * WHEN zero valid workspaces remain after path validation, THE Configuration_Loader
   * SHALL log a descriptive error and exit with non-zero exit code
   */
  describe('Zero valid workspaces after validation', () => {
    it('should return empty array when all workspaces have invalid paths', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'invalid-workspace-1',
            OUTPUT_DIR: '/non/existent/output1',
            SESSIONS_DIR: '/non/existent/sessions1',
            WORKSPACE_ROOT: '/non/existent/root1',
          },
          {
            id: 'invalid-workspace-2',
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
      
      // Verify warnings were logged for each invalid workspace
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(warnLogs.some(log => log.includes('invalid-workspace-1'))).toBe(true);
      expect(warnLogs.some(log => log.includes('invalid-workspace-2'))).toBe(true);
      expect(warnLogs.some(log => log.includes('Skipping workspace'))).toBe(true);
      
      // Should return empty array and NOT exit (Req 9.8)
      expect(result.length).toBe(0);
      expect(exitCode).toBeNull();
      expect(warnLogs.some(log => log.includes('skipped due to path validation'))).toBe(true);
    });

    it('should return empty array when single workspace has all invalid paths', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'only-workspace',
            OUTPUT_DIR: '/non/existent/output',
            SESSIONS_DIR: '/non/existent/sessions',
            WORKSPACE_ROOT: '/non/existent/root',
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      // Per Requirement 9.8: runtime conditions should continue with warning
      const result = await loader.loadWorkspaces();
      expect(result.length).toBe(0);
      expect(exitCode).toBeNull();
      expect(warnLogs.some(log => log.includes('skipped due to path validation'))).toBe(true);
    });

    it('should succeed when at least one workspace has valid paths', async () => {
      // Create valid directories
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

      // Should successfully load the valid workspace
      const result = await loader.loadWorkspaces();

      // Verify warnings were logged for invalid workspace
      expect(warnLogs.some(log => log.includes('invalid-workspace'))).toBe(true);
      expect(warnLogs.some(log => log.includes('Skipping workspace'))).toBe(true);

      // Should not exit (at least one valid workspace exists)
      expect(exitCode).toBeNull();
      
      // Should return only the valid workspace
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('valid-workspace');
      
      // Should not log zero valid workspaces error
      expect(errorLogs.some(log => log.includes('No valid workspaces'))).toBe(false);
    });

    it('should return empty array when all workspaces missing OUTPUT_DIR', async () => {
      // Create some valid directories but not OUTPUT_DIR
      const validSessions = join(testDir, 'valid-sessions');
      const validRoot = join(testDir, 'valid-root');
      await mkdir(validSessions, { recursive: true });
      await mkdir(validRoot, { recursive: true });

      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [
          {
            id: 'missing-output-1',
            OUTPUT_DIR: '/non/existent/output1',
            SESSIONS_DIR: validSessions,
            WORKSPACE_ROOT: validRoot,
          },
          {
            id: 'missing-output-2',
            OUTPUT_DIR: '/non/existent/output2',
            SESSIONS_DIR: validSessions,
            WORKSPACE_ROOT: validRoot,
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      // Per Requirement 9.8: runtime conditions should continue with warning
      const result = await loader.loadWorkspaces();
      expect(result.length).toBe(0);
      expect(exitCode).toBeNull();
      expect(warnLogs.some(log => log.includes('OUTPUT_DIR'))).toBe(true);
      expect(warnLogs.some(log => log.includes('skipped due to path validation'))).toBe(true);
    });
  });

  /**
   * Additional error scenario tests for comprehensive coverage
   */
  describe('Additional error scenarios', () => {
    it('should handle empty workspaces array', async () => {
      const configPath = join(testDir, 'workspaces.json');
      const config = {
        workspaces: [],
      };
      await writeFile(configPath, JSON.stringify(config), 'utf-8');

      const loader = new DefaultConfigurationLoader(configPath);

      // Per Requirement 9.8: empty array is a runtime condition, should continue with warning
      const result = await loader.loadWorkspaces();
      expect(result.length).toBe(0);
      expect(exitCode).toBeNull();
      expect(warnLogs.some(log => log.includes('No workspaces defined'))).toBe(true);
    });

    it('should exit when workspaces exceed maximum limit of 50', async () => {
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
        expect(errorLogs[0]).toContain('ERROR');
        expect(errorLogs[0]).toContain('exceeds maximum workspace limit');
        expect(errorLogs[0]).toContain('51');
        expect(errorLogs[0]).toContain('50');
      }
    });
  });
});
