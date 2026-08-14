// Tests for loadAnalyticsConfig (src/config/analytics-config.ts)
// Requirements: 9.1, 9.2, 9.3

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fc from 'fast-check';
import { loadAnalyticsConfig } from '../src/config/analytics-config';

// ---------------------------------------------------------------------------
// Console capture helpers
// ---------------------------------------------------------------------------

let warnLogs: string[] = [];
let errorLogs: string[] = [];
let originalConsoleWarn: typeof console.warn;
let originalConsoleError: typeof console.error;

function captureConsoleLogs(): void {
  originalConsoleWarn = console.warn;
  originalConsoleError = console.error;
  warnLogs = [];
  errorLogs = [];
  (console as unknown as Record<string, unknown>).warn = mock((...args: unknown[]) => {
    warnLogs.push(args.map(String).join(' '));
  });
  (console as unknown as Record<string, unknown>).error = mock((...args: unknown[]) => {
    errorLogs.push(args.map(String).join(' '));
  });
}

function restoreConsoleLogs(): void {
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
}

// ---------------------------------------------------------------------------
// ANALYTICS_ENABLED — Requirement 9.1
// ---------------------------------------------------------------------------

describe('ANALYTICS_ENABLED', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('should default to true when the variable is absent', () => {
    const config = loadAnalyticsConfig({});

    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it('should default to true when the variable is an empty string', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: '' });

    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it('should set enabled to true when value is "true"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'true' });

    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it('should set enabled to false when value is "false"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'false' });

    expect(config.enabled).toBe(false);
    expect(errorLogs).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it('should be case-insensitive for "TRUE"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'TRUE' });

    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(0);
  });

  it('should be case-insensitive for "FALSE"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'FALSE' });

    expect(config.enabled).toBe(false);
    expect(errorLogs).toHaveLength(0);
  });

  it('should log a config error for an invalid value and default to true', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'yes' });

    // Non-false value → enabled defaults to true
    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toBe("Configuration error: ANALYTICS_ENABLED: must be 'true' or 'false', got 'yes'");
  });

  it('should log a config error for "1" and default to true', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: '1' });

    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain('Configuration error: ANALYTICS_ENABLED:');
  });

  it('should log a config error for "0" and default to true', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: '0' });

    expect(config.enabled).toBe(true);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain('Configuration error: ANALYTICS_ENABLED:');
  });
});

// ---------------------------------------------------------------------------
// ANALYTICS_CACHE_TTL — Requirement 9.2
// ---------------------------------------------------------------------------

describe('ANALYTICS_CACHE_TTL', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('should default to 300 when the variable is absent', () => {
    const config = loadAnalyticsConfig({});

    expect(config.cacheTtl).toBe(300);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it('should default to 300 when the variable is an empty string', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '' });

    expect(config.cacheTtl).toBe(300);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept an in-range value without clamping or warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '300' });

    expect(config.cacheTtl).toBe(300);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept the lower bound (1) without clamping or warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '1' });

    expect(config.cacheTtl).toBe(1);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept the upper bound (86400) without clamping or warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '86400' });

    expect(config.cacheTtl).toBe(86400);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it('should clamp 0 to 1 and log the exact warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '0' });

    expect(config.cacheTtl).toBe(1);
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]).toBe('ANALYTICS_CACHE_TTL 0 adjusted to 1');
  });

  it('should clamp -5 to 1 and log the exact warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '-5' });

    expect(config.cacheTtl).toBe(1);
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]).toBe('ANALYTICS_CACHE_TTL -5 adjusted to 1');
  });

  it('should clamp 100000 to 86400 and log the exact warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '100000' });

    expect(config.cacheTtl).toBe(86400);
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]).toBe('ANALYTICS_CACHE_TTL 100000 adjusted to 86400');
  });

  it('should clamp 86401 to 86400 and log the exact warning', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '86401' });

    expect(config.cacheTtl).toBe(86400);
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]).toBe('ANALYTICS_CACHE_TTL 86401 adjusted to 86400');
  });

  it('should log a config error for a non-numeric value and default to 300', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: 'abc' });

    expect(config.cacheTtl).toBe(300);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toBe("Configuration error: ANALYTICS_CACHE_TTL: must be a numeric integer, got 'abc'");
    expect(warnLogs).toHaveLength(0);
  });

  it('should log a config error for "NaN" and default to 300', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: 'NaN' });

    expect(config.cacheTtl).toBe(300);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain('Configuration error: ANALYTICS_CACHE_TTL:');
    expect(warnLogs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Warning and error log format — Requirement 9.3
// ---------------------------------------------------------------------------

describe('log format compliance', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('clamp warning format: "ANALYTICS_CACHE_TTL <value> adjusted to <clamped>"', () => {
    // Below lower bound
    loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '-100' });

    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]).toMatch(/^ANALYTICS_CACHE_TTL -100 adjusted to 1$/);
  });

  it('clamp warning format for above upper bound', () => {
    loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: '999999' });

    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]).toMatch(/^ANALYTICS_CACHE_TTL 999999 adjusted to 86400$/);
  });

  it('config error format: "Configuration error: <var>: <issue>"', () => {
    // Invalid ANALYTICS_ENABLED value
    loadAnalyticsConfig({ ANALYTICS_ENABLED: 'invalid' });

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toMatch(/^Configuration error: ANALYTICS_ENABLED: /);
  });

  it('config error format for invalid ANALYTICS_CACHE_TTL', () => {
    loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: 'not-a-number' });

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toMatch(/^Configuration error: ANALYTICS_CACHE_TTL: /);
  });

  it('no logs produced for a fully valid configuration', () => {
    loadAnalyticsConfig({ ANALYTICS_ENABLED: 'true', ANALYTICS_CACHE_TTL: '600' });

    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined env — both variables present
// ---------------------------------------------------------------------------

describe('combined ANALYTICS_ENABLED + ANALYTICS_CACHE_TTL', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('should parse both variables independently', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'false', ANALYTICS_CACHE_TTL: '120' });

    expect(config.enabled).toBe(false);
    expect(config.cacheTtl).toBe(120);
    expect(warnLogs).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
  });

  it('should independently handle invalid ANALYTICS_ENABLED with valid TTL', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'maybe', ANALYTICS_CACHE_TTL: '600' });

    expect(config.enabled).toBe(true);
    expect(config.cacheTtl).toBe(600);
    expect(errorLogs).toHaveLength(1);
    expect(warnLogs).toHaveLength(0);
  });

  it('should independently handle valid ANALYTICS_ENABLED with out-of-range TTL', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_ENABLED: 'true', ANALYTICS_CACHE_TTL: '0' });

    expect(config.enabled).toBe(true);
    expect(config.cacheTtl).toBe(1);
    expect(warnLogs).toHaveLength(1);
    expect(errorLogs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — Requirement 9.2, 12.1
// ---------------------------------------------------------------------------

describe('property: TTL clamping invariants', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('property: cacheTtl is always in [1, 86400] for any integer input', () => {
    fc.assert(
      fc.property(
        // Generate integers well outside range to exercise both sides
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (value) => {
          warnLogs = [];
          errorLogs = [];
          const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: String(value) });

          expect(config.cacheTtl).toBeGreaterThanOrEqual(1);
          expect(config.cacheTtl).toBeLessThanOrEqual(86400);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('property: in-range values are preserved exactly (no clamping)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 86400 }),
        (value) => {
          warnLogs = [];
          errorLogs = [];
          const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: String(value) });

          expect(config.cacheTtl).toBe(value);
          expect(warnLogs).toHaveLength(0);
          expect(errorLogs).toHaveLength(0);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('property: below-range values always clamp to 1 and log a warning', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 0 }),
        (value) => {
          warnLogs = [];
          errorLogs = [];
          const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: String(value) });

          expect(config.cacheTtl).toBe(1);
          expect(warnLogs).toHaveLength(1);
          expect(warnLogs[0]).toBe(`ANALYTICS_CACHE_TTL ${value} adjusted to 1`);
          expect(errorLogs).toHaveLength(0);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('property: above-range values always clamp to 86400 and log a warning', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 86401, max: 10_000_000 }),
        (value) => {
          warnLogs = [];
          errorLogs = [];
          const config = loadAnalyticsConfig({ ANALYTICS_CACHE_TTL: String(value) });

          expect(config.cacheTtl).toBe(86400);
          expect(warnLogs).toHaveLength(1);
          expect(warnLogs[0]).toBe(`ANALYTICS_CACHE_TTL ${value} adjusted to 86400`);
          expect(errorLogs).toHaveLength(0);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('property: enabled is always boolean true or false', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant('true'),
          fc.constant('false'),
          fc.constant('TRUE'),
          fc.constant('FALSE'),
          fc.string()
        ),
        (value) => {
          warnLogs = [];
          errorLogs = [];
          const env: Record<string, string | undefined> = {};
          if (value !== undefined) env['ANALYTICS_ENABLED'] = value;
          const config = loadAnalyticsConfig(env);

          // enabled must strictly be a boolean — never null/undefined/number
          expect(typeof config.enabled).toBe('boolean');
        }
      ),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// ANALYTICS_CACHE_LOG_ENABLED — Requirement 11.1
// ---------------------------------------------------------------------------

describe('ANALYTICS_CACHE_LOG_ENABLED', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('should default to false when the variable is absent', () => {
    const config = loadAnalyticsConfig({});

    expect(config.cacheLoggingEnabled).toBe(false);
    expect(errorLogs).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it('should default to false when the variable is an empty string', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_LOG_ENABLED: '' });

    expect(config.cacheLoggingEnabled).toBe(false);
  });

  it('should set cacheLoggingEnabled to true when value is "true"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_LOG_ENABLED: 'true' });

    expect(config.cacheLoggingEnabled).toBe(true);
    expect(errorLogs).toHaveLength(0);
  });

  it('should set cacheLoggingEnabled to false when value is "false"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_LOG_ENABLED: 'false' });

    expect(config.cacheLoggingEnabled).toBe(false);
    expect(errorLogs).toHaveLength(0);
  });

  it('should be case-insensitive for "TRUE"', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_LOG_ENABLED: 'TRUE' });

    expect(config.cacheLoggingEnabled).toBe(true);
    expect(errorLogs).toHaveLength(0);
  });

  it('should log a config error for an invalid value and default to false', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_CACHE_LOG_ENABLED: 'yes' });

    expect(config.cacheLoggingEnabled).toBe(false);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toBe("Configuration error: ANALYTICS_CACHE_LOG_ENABLED: must be 'true' or 'false', got 'yes'");
  });
});

// ---------------------------------------------------------------------------
// ANALYTICS_LOG_LEVEL — Requirement 11.1
// ---------------------------------------------------------------------------

describe('ANALYTICS_LOG_LEVEL', () => {
  beforeEach(captureConsoleLogs);
  afterEach(restoreConsoleLogs);

  it('should default to INFO when the variable is absent', () => {
    const config = loadAnalyticsConfig({});

    expect(config.logLevel).toBe('INFO');
    expect(errorLogs).toHaveLength(0);
  });

  it('should default to INFO when the variable is an empty string', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: '' });

    expect(config.logLevel).toBe('INFO');
  });

  it('should accept DEBUG', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'DEBUG' });

    expect(config.logLevel).toBe('DEBUG');
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept INFO', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'INFO' });

    expect(config.logLevel).toBe('INFO');
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept WARN', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'WARN' });

    expect(config.logLevel).toBe('WARN');
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept ERROR', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'ERROR' });

    expect(config.logLevel).toBe('ERROR');
    expect(errorLogs).toHaveLength(0);
  });

  it('should accept FATAL', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'FATAL' });

    expect(config.logLevel).toBe('FATAL');
    expect(errorLogs).toHaveLength(0);
  });

  it('should be case-insensitive — accept "warn" as WARN', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'warn' });

    expect(config.logLevel).toBe('WARN');
    expect(errorLogs).toHaveLength(0);
  });

  it('should log a config error for an unrecognized level and default to INFO', () => {
    const config = loadAnalyticsConfig({ ANALYTICS_LOG_LEVEL: 'VERBOSE' });

    expect(config.logLevel).toBe('INFO');
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toMatch(/^Configuration error: ANALYTICS_LOG_LEVEL: must be one of/);
    expect(errorLogs[0]).toContain("got 'VERBOSE'");
  });

  it('property: logLevel is always one of the five valid levels', () => {
    const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(''),
          fc.constantFrom('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL',
            'debug', 'info', 'warn', 'error', 'fatal'),
          fc.string(),
        ),
        (value) => {
          warnLogs = [];
          errorLogs = [];
          const env: Record<string, string | undefined> = {};
          if (value !== undefined) env['ANALYTICS_LOG_LEVEL'] = value;
          const config = loadAnalyticsConfig(env);

          expect(validLevels).toContain(config.logLevel);
        }
      ),
      { numRuns: 300 }
    );
  });
});
