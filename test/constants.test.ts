import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { resolveConstants } from '../src/constants';

// ============================================================================
// Phase 6.2 — VOYAGE_API_KEY and MEMORY_HOT_TIER_COUNT constants
// ============================================================================

describe('resolveConstants — Phase 6.2 constants', () => {
  // --------------------------------------------------------------------------
  // VOYAGE_API_KEY
  // --------------------------------------------------------------------------

  it('should return VOYAGE_API_KEY as empty string when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.VOYAGE_API_KEY).toBe('');
  });

  it('should return VOYAGE_API_KEY from env when provided', () => {
    const result = resolveConstants({ VOYAGE_API_KEY: 'pa-abc123' });
    expect(result.VOYAGE_API_KEY).toBe('pa-abc123');
  });

  // --------------------------------------------------------------------------
  // MEMORY_HOT_TIER_COUNT — default fallback
  // --------------------------------------------------------------------------

  it('should return MEMORY_HOT_TIER_COUNT=100 when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
  });

  it('should return MEMORY_HOT_TIER_COUNT=100 when env var is an empty string', () => {
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: '' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
  });

  it('should return MEMORY_HOT_TIER_COUNT=100 when env var is alphabetic', () => {
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: 'abc' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
  });

  it('should truncate float strings to integer part (parseInt behaviour) — "3.5" → 3', () => {
    // parseInt('3.5', 10) === 3: a valid integer, so no fallback applies
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: '3.5' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(3);
  });

  it('should return MEMORY_HOT_TIER_COUNT=100 when env var is "NaN"', () => {
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: 'NaN' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
  });

  it('should return MEMORY_HOT_TIER_COUNT=100 when env var is whitespace', () => {
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: '   ' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
  });

  it('should parse MEMORY_HOT_TIER_COUNT correctly when env var is a valid integer string', () => {
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: '250' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(250);
  });

  it('should parse MEMORY_HOT_TIER_COUNT=1 (minimum valid value)', () => {
    const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: '1' });
    expect(result.MEMORY_HOT_TIER_COUNT).toBe(1);
  });

  // --------------------------------------------------------------------------
  // MEMORY_HOT_TIER_COUNT — parameterised non-integer inputs that fall back
  // --------------------------------------------------------------------------

  const nonIntegerInputs: Array<{ label: string; value: string }> = [
    { label: 'alphabetic', value: 'abc' },
    { label: 'empty string', value: '' },
    { label: 'whitespace only', value: '   ' },
    { label: '"NaN" literal', value: 'NaN' },
    { label: 'special chars', value: '!@#$' },
    { label: 'json object', value: '{}' },
    { label: 'boolean string', value: 'true' },
  ];

  for (const { label, value } of nonIntegerInputs) {
    it(`should return MEMORY_HOT_TIER_COUNT=100 when env var is ${label}`, () => {
      const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: value });
      expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
    });
  }

  // --------------------------------------------------------------------------
  // Property test: any non-integer string → default 100
  // --------------------------------------------------------------------------

  it('property: non-numeric strings always produce MEMORY_HOT_TIER_COUNT=100', () => {
    // Arbitrary: strings that parseInt would consider NaN (no leading digit)
    const nonNumericStringArb = fc.stringMatching(/^[^0-9\-\+][^0-9]*/);

    fc.assert(
      fc.property(nonNumericStringArb, (value) => {
        const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: value });
        expect(result.MEMORY_HOT_TIER_COUNT).toBe(100);
      }),
      { numRuns: 200 },
    );
  });

  // --------------------------------------------------------------------------
  // Property test: valid integer strings ≥ 1 round-trip correctly
  // --------------------------------------------------------------------------

  it('property: valid positive integer strings round-trip through MEMORY_HOT_TIER_COUNT', () => {
    const positiveIntegerArb = fc.integer({ min: 1, max: 10_000 });

    fc.assert(
      fc.property(positiveIntegerArb, (n) => {
        const result = resolveConstants({ MEMORY_HOT_TIER_COUNT: String(n) });
        expect(result.MEMORY_HOT_TIER_COUNT).toBe(n);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Property-Based Tests for resolveConstants defaults
 *
 * Verifies that when the eight Phase 6.1 memory env vars are absent,
 * resolveConstants always returns the correct default values regardless
 * of what other env keys are present.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**
 */

// ============================================================================
// Arbitraries
// ============================================================================

/**
 * Arbitrary that generates env-like objects without any of the eight memory keys.
 * Uses fc.record({}) as the base and extends with a random selection of
 * non-memory key/value pairs to simulate realistic process.env objects.
 */
const nonMemoryEnvArb: fc.Arbitrary<NodeJS.ProcessEnv> = fc.record(
  {
    PORT: fc.option(fc.stringMatching(/^\d{1,5}$/), { nil: undefined }),
    OUTPUT_DIR: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    SESSIONS_DIR: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    WORKSPACE_ROOT: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    SPECS_DIR: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    NODE_ENV: fc.option(fc.constantFrom('development', 'production', 'test'), { nil: undefined }),
  },
  { requiredKeys: [] },
);

// ============================================================================
// Property Tests
// ============================================================================

describe('resolveConstants — Phase 6.1 memory defaults', () => {
  // Feature: phase-6.1-memory-infrastructure, Property 2: resolveConstants produces correct defaults for any env without memory keys

  it('property: resolveConstants produces correct defaults when memory env vars are absent', () => {
    fc.assert(
      fc.property(nonMemoryEnvArb, (env) => {
        const constants = resolveConstants(env);

        // MEMORY_ENABLED defaults to false when env var is absent
        expect(constants.MEMORY_ENABLED).toBe(false);

        // HINDSIGHT_URL defaults to 'http://localhost:3100'
        expect(constants.HINDSIGHT_URL).toBe('http://localhost:3100');

        // MEMORY_EXTRACTION_ENABLED defaults to false
        expect(constants.MEMORY_EXTRACTION_ENABLED).toBe(false);

        // MEMORY_AUTO_INJECT defaults to false
        expect(constants.MEMORY_AUTO_INJECT).toBe(false);

        // MEMORY_MAX_CONTEXT_MEMORIES defaults to 10
        expect(constants.MEMORY_MAX_CONTEXT_MEMORIES).toBe(10);

        // MEMORY_CONTEXT_TOKEN_BUDGET defaults to 2000
        expect(constants.MEMORY_CONTEXT_TOKEN_BUDGET).toBe(2000);

        // MEMORY_DECAY_DAYS defaults to 90
        expect(constants.MEMORY_DECAY_DAYS).toBe(90);

        // MEMORY_RETRY_PATH defaults to 'data/memory-retry-queue.jsonl'
        expect(constants.MEMORY_RETRY_PATH).toBe('data/memory-retry-queue.jsonl');
      }),
      { numRuns: 100 },
    );
  });

  // Supplementary unit tests to confirm each default individually

  it('should return MEMORY_ENABLED=false when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.MEMORY_ENABLED).toBe(false);
  });

  it('should return MEMORY_ENABLED=false when env var is a falsy non-"true" value', () => {
    const result = resolveConstants({ MEMORY_ENABLED: '1' });
    expect(result.MEMORY_ENABLED).toBe(false);
  });

  it('should return MEMORY_ENABLED=true when env var is exactly "true"', () => {
    const result = resolveConstants({ MEMORY_ENABLED: 'true' });
    expect(result.MEMORY_ENABLED).toBe(true);
  });

  it('should return HINDSIGHT_URL default when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.HINDSIGHT_URL).toBe('http://localhost:3100');
  });

  it('should return HINDSIGHT_URL from env when provided', () => {
    const result = resolveConstants({ HINDSIGHT_URL: 'http://my-hindsight:4200' });
    expect(result.HINDSIGHT_URL).toBe('http://my-hindsight:4200');
  });

  it('should return MEMORY_MAX_CONTEXT_MEMORIES=10 when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.MEMORY_MAX_CONTEXT_MEMORIES).toBe(10);
  });

  it('should return MEMORY_MAX_CONTEXT_MEMORIES parsed as integer from env', () => {
    const result = resolveConstants({ MEMORY_MAX_CONTEXT_MEMORIES: '25' });
    expect(result.MEMORY_MAX_CONTEXT_MEMORIES).toBe(25);
  });

  it('should return MEMORY_CONTEXT_TOKEN_BUDGET=2000 when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.MEMORY_CONTEXT_TOKEN_BUDGET).toBe(2000);
  });

  it('should return MEMORY_DECAY_DAYS=90 when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.MEMORY_DECAY_DAYS).toBe(90);
  });

  it('should return MEMORY_RETRY_PATH default when env var is absent', () => {
    const result = resolveConstants({});
    expect(result.MEMORY_RETRY_PATH).toBe('data/memory-retry-queue.jsonl');
  });
});
