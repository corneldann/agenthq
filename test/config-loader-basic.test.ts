import { describe, it, expect } from 'bun:test';
import { DefaultConfigurationLoader, type WorkspaceConfig } from '../src/config/workspace-config';

describe('WorkspaceConfig - Basic Functionality', () => {
  describe('applyDefaults', () => {
    it('should apply CHAINS_DIR default to SESSIONS_DIR when omitted', () => {
      const loader = new DefaultConfigurationLoader();
      const config: WorkspaceConfig = {
        id: 'test-workspace',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
      };

      const result = loader.applyDefaults(config);

      expect(result.CHAINS_DIR).toBe('/path/to/sessions');
    });

    it('should apply PROMPT_OUTPUT_DIR default to OUTPUT_DIR when omitted', () => {
      const loader = new DefaultConfigurationLoader();
      const config: WorkspaceConfig = {
        id: 'test-workspace',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
      };

      const result = loader.applyDefaults(config);

      expect(result.PROMPT_OUTPUT_DIR).toBe('/path/to/output');
    });

    it('should preserve explicitly set optional fields', () => {
      const loader = new DefaultConfigurationLoader();
      const config: WorkspaceConfig = {
        id: 'test-workspace',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
        CHAINS_DIR: '/custom/chains',
        PROMPT_OUTPUT_DIR: '/custom/prompt',
        SPECS_DIR: '/custom/specs',
      };

      const result = loader.applyDefaults(config);

      expect(result.CHAINS_DIR).toBe('/custom/chains');
      expect(result.PROMPT_OUTPUT_DIR).toBe('/custom/prompt');
      expect(result.SPECS_DIR).toBe('/custom/specs');
    });

    it('should preserve optional queue file paths', () => {
      const loader = new DefaultConfigurationLoader();
      const config: WorkspaceConfig = {
        id: 'test-workspace',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
        CRAWL_JOBS_FILE: 'docs/.crawl-queue.json',
        CLONE_JOBS_FILE: 'docs/.clone-queue.json',
        BUILD_QUEUE_FILE: 'docs/.build-queue.json',
      };

      const result = loader.applyDefaults(config);

      expect(result.CRAWL_JOBS_FILE).toBe('docs/.crawl-queue.json');
      expect(result.CLONE_JOBS_FILE).toBe('docs/.clone-queue.json');
      expect(result.BUILD_QUEUE_FILE).toBe('docs/.build-queue.json');
    });

    it('should handle mixed optional fields correctly', () => {
      const loader = new DefaultConfigurationLoader();
      const config: WorkspaceConfig = {
        id: 'test-workspace',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
        CHAINS_DIR: '/custom/chains', // explicitly set
        // PROMPT_OUTPUT_DIR omitted - should default
        SPECS_DIR: '/custom/specs', // explicitly set
        CRAWL_JOBS_FILE: 'queue/crawl.json', // explicitly set
        // Other queue files omitted
      };

      const result = loader.applyDefaults(config);

      expect(result.CHAINS_DIR).toBe('/custom/chains'); // preserved
      expect(result.PROMPT_OUTPUT_DIR).toBe('/path/to/output'); // defaulted
      expect(result.SPECS_DIR).toBe('/custom/specs'); // preserved
      expect(result.CRAWL_JOBS_FILE).toBe('queue/crawl.json'); // preserved
      expect(result.CLONE_JOBS_FILE).toBeUndefined(); // not set
      expect(result.BUILD_QUEUE_FILE).toBeUndefined(); // not set
    });

    it('should not mutate the original config object', () => {
      const loader = new DefaultConfigurationLoader();
      const config: WorkspaceConfig = {
        id: 'test-workspace',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
      };

      const result = loader.applyDefaults(config);

      // Result should have defaults applied
      expect(result.CHAINS_DIR).toBe('/path/to/sessions');
      expect(result.PROMPT_OUTPUT_DIR).toBe('/path/to/output');

      // Original should remain unchanged
      expect(config.CHAINS_DIR).toBeUndefined();
      expect(config.PROMPT_OUTPUT_DIR).toBeUndefined();
    });
  });

  describe('WorkspaceConfig Interface', () => {
    it('should accept valid workspace configuration', () => {
      const config: WorkspaceConfig = {
        id: 'valid-workspace-123',
        OUTPUT_DIR: '/path/to/output',
        SESSIONS_DIR: '/path/to/sessions',
        WORKSPACE_ROOT: '/path/to/root',
      };

      expect(config.id).toBe('valid-workspace-123');
      expect(config.OUTPUT_DIR).toBe('/path/to/output');
      expect(config.SESSIONS_DIR).toBe('/path/to/sessions');
      expect(config.WORKSPACE_ROOT).toBe('/path/to/root');
    });

    it('should accept workspace ID with lowercase alphanumeric and hyphens', () => {
      const validIds = [
        'workspace',
        'workspace-123',
        'test-workspace-abc',
        '123-abc',
        'a',
        'workspace-with-many-hyphens-ok',
      ];

      for (const id of validIds) {
        const config: WorkspaceConfig = {
          id,
          OUTPUT_DIR: '/path/to/output',
          SESSIONS_DIR: '/path/to/sessions',
          WORKSPACE_ROOT: '/path/to/root',
        };
        expect(config.id).toBe(id);
      }
    });
  });
});
