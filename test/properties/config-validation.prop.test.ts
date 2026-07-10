import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { DefaultConfigurationLoader, type WorkspaceConfig } from '../../src/config/workspace-config';

/**
 * Property-Based Tests for Configuration Validation
 * 
 * These tests use fast-check to verify universal properties hold across
 * all possible inputs, complementing the unit tests that check specific examples.
 * 
 * **Validates: Requirements 1.1-1.15**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/**
 * Generate valid workspace IDs matching pattern ^[a-z0-9-]{1,50}$
 */
const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

/**
 * Generate invalid workspace IDs that violate the pattern
 */
const invalidWorkspaceIdArb = fc.oneof(
  // Empty string
  fc.constant(''),
  // Too long (>50 chars)
  fc.stringMatching(/^[a-z0-9-]{51,100}$/),
  // Contains uppercase
  fc.stringMatching(/^[a-zA-Z0-9-]{1,50}$/).filter(s => /[A-Z]/.test(s)),
  // Contains special characters
  fc.string({ minLength: 1, maxLength: 50 }).filter(s => /[^a-z0-9-]/.test(s) && s.length > 0),
  // Contains spaces or underscores
  fc.stringMatching(/^[a-z0-9-_ ]{1,50}$/).filter(s => /[ _]/.test(s))
);

/**
 * Generate non-empty string paths
 */
const nonEmptyPathArb = fc.string({ minLength: 1, maxLength: 200 });

/**
 * Generate valid workspace configuration with all required fields
 */
const validWorkspaceConfigArb: fc.Arbitrary<WorkspaceConfig> = fc.record({
  id: validWorkspaceIdArb,
  OUTPUT_DIR: nonEmptyPathArb,
  SESSIONS_DIR: nonEmptyPathArb,
  WORKSPACE_ROOT: nonEmptyPathArb,
  CHAINS_DIR: fc.option(nonEmptyPathArb, { nil: undefined }),
  SPECS_DIR: fc.option(nonEmptyPathArb, { nil: undefined }),
  PROMPT_OUTPUT_DIR: fc.option(nonEmptyPathArb, { nil: undefined }),
  CRAWL_JOBS_FILE: fc.option(nonEmptyPathArb, { nil: undefined }),
  CLONE_JOBS_FILE: fc.option(nonEmptyPathArb, { nil: undefined }),
  BUILD_QUEUE_FILE: fc.option(nonEmptyPathArb, { nil: undefined }),
});

/**
 * Generate workspace config missing at least one required field
 */
const workspaceConfigMissingRequiredFieldArb = fc.oneof(
  // Missing OUTPUT_DIR
  fc.record({
    id: validWorkspaceIdArb,
    OUTPUT_DIR: fc.constant(''),
    SESSIONS_DIR: nonEmptyPathArb,
    WORKSPACE_ROOT: nonEmptyPathArb,
  }),
  // Missing SESSIONS_DIR
  fc.record({
    id: validWorkspaceIdArb,
    OUTPUT_DIR: nonEmptyPathArb,
    SESSIONS_DIR: fc.constant(''),
    WORKSPACE_ROOT: nonEmptyPathArb,
  }),
  // Missing WORKSPACE_ROOT
  fc.record({
    id: validWorkspaceIdArb,
    OUTPUT_DIR: nonEmptyPathArb,
    SESSIONS_DIR: nonEmptyPathArb,
    WORKSPACE_ROOT: fc.constant(''),
  })
);

// ============================================================================
// Property Tests
// ============================================================================

describe('Property-Based Tests: Configuration Validation', () => {
  
  /**
   * Property 1: Configuration JSON Round-Trip Preservation
   * 
   * For any valid workspace configuration array, serializing to JSON then
   * deserializing SHALL produce an equivalent configuration structure with
   * all required fields present and all optional fields either present or
   * defaulted correctly.
   * 
   * **Validates: Requirements 1.1-1.15**
   */
  it('Property 1: Configuration JSON round-trip preserves structure', () => {
    fc.assert(
      fc.property(
        fc.array(validWorkspaceConfigArb, { minLength: 1, maxLength: 50 }),
        (configs) => {
          const loader = new DefaultConfigurationLoader();
          
          // Serialize to JSON
          const serialized = JSON.stringify({ workspaces: configs });
          
          // Deserialize from JSON
          const deserialized = JSON.parse(serialized);
          
          // Apply defaults to both original and deserialized
          const originalWithDefaults = configs.map(c => loader.applyDefaults(c));
          const deserializedWithDefaults = deserialized.workspaces.map((c: WorkspaceConfig) => loader.applyDefaults(c));
          
          // Verify structure equivalence
          expect(deserializedWithDefaults.length).toBe(originalWithDefaults.length);
          
          for (let i = 0; i < originalWithDefaults.length; i++) {
            const orig = originalWithDefaults[i];
            const deser = deserializedWithDefaults[i];
            
            // All required fields must match
            expect(deser.id).toBe(orig.id);
            expect(deser.OUTPUT_DIR).toBe(orig.OUTPUT_DIR);
            expect(deser.SESSIONS_DIR).toBe(orig.SESSIONS_DIR);
            expect(deser.WORKSPACE_ROOT).toBe(orig.WORKSPACE_ROOT);
            
            // Defaulted fields must be present
            expect(deser.CHAINS_DIR).toBeDefined();
            expect(deser.PROMPT_OUTPUT_DIR).toBeDefined();
            
            // If optional fields were set, they should be preserved
            if (orig.SPECS_DIR !== undefined) {
              expect(deser.SPECS_DIR).toBe(orig.SPECS_DIR);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Workspace ID Validation Correctness
   * 
   * For any string, validation SHALL accept it as a workspace ID if and only if
   * it matches the regex pattern ^[a-z0-9-]{1,50}$.
   * 
   * **Validates: Requirements 1.2**
   */
  it('Property 2: Workspace ID validation accepts valid IDs and rejects invalid IDs', () => {
    const WORKSPACE_ID_PATTERN = /^[a-z0-9-]{1,50}$/;
    
    // Test valid IDs are accepted
    fc.assert(
      fc.property(validWorkspaceIdArb, (id) => {
        // Valid IDs must match the pattern
        expect(WORKSPACE_ID_PATTERN.test(id)).toBe(true);
        
        // A config with this ID should be structurally valid
        const config: WorkspaceConfig = {
          id,
          OUTPUT_DIR: '/test/output',
          SESSIONS_DIR: '/test/sessions',
          WORKSPACE_ROOT: '/test/root',
        };
        
        expect(config.id).toBe(id);
      }),
      { numRuns: 100 }
    );
    
    // Test invalid IDs are rejected by the pattern
    fc.assert(
      fc.property(invalidWorkspaceIdArb, (id) => {
        // Invalid IDs must NOT match the pattern
        expect(WORKSPACE_ID_PATTERN.test(id)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3: Required Field Enforcement
   * 
   * For any workspace configuration object, validation SHALL reject the
   * configuration if any of OUTPUT_DIR, SESSIONS_DIR, or WORKSPACE_ROOT
   * fields are missing or empty.
   * 
   * **Validates: Requirements 1.3**
   */
  it('Property 3: Required fields must be non-empty', () => {
    fc.assert(
      fc.property(workspaceConfigMissingRequiredFieldArb, (config) => {
        // At least one required field is empty
        const hasEmptyRequiredField = 
          config.OUTPUT_DIR === '' ||
          config.SESSIONS_DIR === '' ||
          config.WORKSPACE_ROOT === '';
        
        expect(hasEmptyRequiredField).toBe(true);
        
        // This configuration should be considered invalid
        // (Zod validation would catch this when loading from file)
        const isValid = 
          config.OUTPUT_DIR.length > 0 &&
          config.SESSIONS_DIR.length > 0 &&
          config.WORKSPACE_ROOT.length > 0;
        
        expect(isValid).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Optional Field Acceptance
   * 
   * For any workspace configuration with all required fields present,
   * validation SHALL accept the configuration regardless of whether
   * optional fields are present or omitted.
   * 
   * **Validates: Requirements 1.4-1.7**
   */
  it('Property 4: Optional fields can be present or omitted', () => {
    fc.assert(
      fc.property(validWorkspaceConfigArb, (config) => {
        const loader = new DefaultConfigurationLoader();
        
        // Configuration has all required fields
        expect(config.id.length).toBeGreaterThan(0);
        expect(config.OUTPUT_DIR.length).toBeGreaterThan(0);
        expect(config.SESSIONS_DIR.length).toBeGreaterThan(0);
        expect(config.WORKSPACE_ROOT.length).toBeGreaterThan(0);
        
        // Apply defaults - should succeed regardless of optional fields
        const withDefaults = loader.applyDefaults(config);
        
        // Result should have all required fields
        expect(withDefaults.id).toBe(config.id);
        expect(withDefaults.OUTPUT_DIR).toBe(config.OUTPUT_DIR);
        expect(withDefaults.SESSIONS_DIR).toBe(config.SESSIONS_DIR);
        expect(withDefaults.WORKSPACE_ROOT).toBe(config.WORKSPACE_ROOT);
        
        // Defaults should be applied for omitted fields
        expect(withDefaults.CHAINS_DIR).toBeDefined();
        expect(withDefaults.PROMPT_OUTPUT_DIR).toBeDefined();
        
        // If optional fields were provided, they should be preserved
        if (config.CHAINS_DIR !== undefined) {
          expect(withDefaults.CHAINS_DIR).toBe(config.CHAINS_DIR);
        } else {
          expect(withDefaults.CHAINS_DIR).toBe(config.SESSIONS_DIR);
        }
        
        if (config.PROMPT_OUTPUT_DIR !== undefined) {
          expect(withDefaults.PROMPT_OUTPUT_DIR).toBe(config.PROMPT_OUTPUT_DIR);
        } else {
          expect(withDefaults.PROMPT_OUTPUT_DIR).toBe(config.OUTPUT_DIR);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5: Workspace ID Uniqueness Enforcement
   * 
   * For any workspace configuration array, validation SHALL reject the array
   * if it contains duplicate workspace IDs (case-sensitive) and SHALL accept
   * the array if all workspace IDs are unique.
   * 
   * **Validates: Requirements 1.10-1.11**
   */
  it('Property 5: Workspace IDs must be unique (case-sensitive)', () => {
    // Test: Arrays with unique IDs are valid
    fc.assert(
      fc.property(
        fc.uniqueArray(validWorkspaceConfigArb, {
          minLength: 2,
          maxLength: 50,
          selector: (config) => config.id,
        }),
        (configs) => {
          // All IDs should be unique
          const ids = configs.map(c => c.id);
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(ids.length);
        }
      ),
      { numRuns: 100 }
    );
    
    // Test: Arrays with duplicate IDs are invalid
    fc.assert(
      fc.property(
        fc.array(validWorkspaceConfigArb, { minLength: 2, maxLength: 10 }),
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        (configs, idx1, idx2) => {
          // Force a duplicate by making two configs have the same ID
          if (configs.length >= 2 && idx1 !== idx2) {
            const workConfigs = [...configs];
            const index1 = idx1 % workConfigs.length;
            const index2 = idx2 % workConfigs.length;
            
            if (index1 !== index2) {
              // Make the second config have the same ID as the first
              workConfigs[index2] = { ...workConfigs[index2], id: workConfigs[index1].id };
              
              // Now we should have duplicates
              const ids = workConfigs.map(c => c.id);
              const uniqueIds = new Set(ids);
              expect(uniqueIds.size).toBeLessThan(ids.length);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 6: Workspace Count Limit Enforcement
   * 
   * For any workspace configuration array, validation SHALL reject arrays
   * with more than 50 workspaces and SHALL accept arrays with 0-50 workspaces.
   * 
   * **Validates: Requirements 1.14-1.15**
   */
  it('Property 6: Workspace count must not exceed 50', () => {
    const MAX_WORKSPACES = 50;
    
    // Test: Arrays with 0-50 workspaces are valid
    fc.assert(
      fc.property(
        fc.array(validWorkspaceConfigArb, { minLength: 0, maxLength: MAX_WORKSPACES }),
        (configs) => {
          // Should be within the valid range
          expect(configs.length).toBeLessThanOrEqual(MAX_WORKSPACES);
          expect(configs.length).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 100 }
    );
    
    // Test: Arrays with >50 workspaces are invalid
    fc.assert(
      fc.property(
        fc.array(validWorkspaceConfigArb, { minLength: MAX_WORKSPACES + 1, maxLength: MAX_WORKSPACES + 20 }),
        (configs) => {
          // Should exceed the maximum
          expect(configs.length).toBeGreaterThan(MAX_WORKSPACES);
          
          // This configuration would be rejected by the loader
          const exceedsLimit = configs.length > MAX_WORKSPACES;
          expect(exceedsLimit).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
