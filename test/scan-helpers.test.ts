// Feature: monitor-server-split, Task 2.3 — Property tests for scan/helpers.ts
// Validates: Requirements 2.3, 13.1

import { test, expect, describe } from 'bun:test';
import * as fc from 'fast-check';
import {
  extractHeader,
  detectStatus,
  extractAgentDone,
  parseTimestamp,
  extractName,
  extractSessionChainId,
} from '../src/scan/helpers.ts';

// ---------------------------------------------------------------------------
// Property 5 (partial): Scan module purity — no side effects on import
// ---------------------------------------------------------------------------

describe('scan/helpers.ts module purity', () => {
  test('importing helpers.ts does not call setInterval', async () => {
    let callCount = 0;
    const original = globalThis.setInterval;
    // @ts-expect-error — patching global for spy
    globalThis.setInterval = (...args: unknown[]) => {
      callCount++;
      return original(...(args as Parameters<typeof original>));
    };
    await import('../src/scan/helpers.ts');
    globalThis.setInterval = original;
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractHeader
// ---------------------------------------------------------------------------

describe('extractHeader', () => {
  test('returns "unknown" for any string without <!--', () => {
    // headerName is constrained to word characters (no regex metacharacters),
    // matching the real-world usage pattern (e.g. "type", "agent", "status").
    fc.assert(
      fc.property(
        fc.string().filter(s => !s.includes('<!--')),
        fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
        (content, headerName) => {
          expect(extractHeader(content, headerName)).toBe('unknown');
        }
      ),
      { numRuns: 200 }
    );
  });

  test('positive: extracts value from <!-- type: analysis -->', () => {
    expect(extractHeader('<!-- type: analysis -->', 'type')).toBe('analysis');
  });
});

// ---------------------------------------------------------------------------
// parseTimestamp
// ---------------------------------------------------------------------------

describe('parseTimestamp', () => {
  test('result is always "unknown" or matches YYYY-MM-DD HH:mm', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (filename) => {
          const result = parseTimestamp(filename);
          const isUnknown = result === 'unknown';
          const isFormatted = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(result);
          expect(isUnknown || isFormatted).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  test('valid filename always produces YYYY-MM-DD HH:mm format', () => {
    const year = fc.integer({ min: 2000, max: 2099 }).map(n => String(n));
    const month = fc.integer({ min: 1, max: 12 }).map(n => String(n).padStart(2, '0'));
    const day = fc.integer({ min: 1, max: 28 }).map(n => String(n).padStart(2, '0'));
    const hour = fc.integer({ min: 0, max: 23 }).map(n => String(n).padStart(2, '0'));
    const min = fc.integer({ min: 0, max: 59 }).map(n => String(n).padStart(2, '0'));

    fc.assert(
      fc.property(
        fc.tuple(year, month, day, hour, min),
        ([y, mo, d, h, mi]) => {
          const filename = `${y}-${mo}-${d}-${h}${mi}-some-job.md`;
          const result = parseTimestamp(filename);
          expect(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(result)).toBe(true);
          expect(result).toBe(`${y}-${mo}-${d} ${h}:${mi}`);
        }
      ),
      { numRuns: 200 }
    );
  });

  test('positive: "2026-01-10-1200-job.md" → "2026-01-10 12:00"', () => {
    expect(parseTimestamp('2026-01-10-1200-job.md')).toBe('2026-01-10 12:00');
  });
});

// ---------------------------------------------------------------------------
// extractName
// ---------------------------------------------------------------------------

describe('extractName', () => {
  test('never throws on arbitrary input, always returns a string', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (s) => {
          const result = extractName(s);
          expect(typeof result).toBe('string');
        }
      ),
      { numRuns: 200 }
    );
  });

  test('positive: "2026-01-10-1200-some-job-name.md" → "some-job-name"', () => {
    expect(extractName('2026-01-10-1200-some-job-name.md')).toBe('some-job-name');
  });
});

// ---------------------------------------------------------------------------
// detectStatus — branch coverage (deterministic)
// ---------------------------------------------------------------------------

describe('detectStatus', () => {
  // error branches
  test('error branch 1: log contains "Error:"', () => {
    expect(detectStatus('', 'Error: something went wrong', 'agenthq')).toBe('error');
  });

  test('error branch 2: log contains "Response failed"', () => {
    expect(detectStatus('', 'Response failed after 3 retries', 'agenthq')).toBe('error');
  });

  test('error branch 3: log matches exit code [^0]', () => {
    expect(detectStatus('', 'Process exited with exit code 1', 'agenthq')).toBe('error');
  });

  // done branches
  test('done branch 1: md has "## Result" AND "- Commit:"', () => {
    expect(detectStatus('## Result\n- Commit: abc123', null, 'agenthq')).toBe('done');
  });

  test('done branch 2: md contains "[agenthq] done in"', () => {
    expect(detectStatus('[agenthq] done in 42s', null, 'agenthq')).toBe('done');
  });

  test('done branch 3: md contains "[goose_recipe_worker] Done"', () => {
    expect(detectStatus('[goose_recipe_worker] Done processing', null, 'goose')).toBe('done');
  });

  test('done branch 4: md contains "Summary written to "', () => {
    expect(detectStatus('Summary written to output.md', null, 'agenthq')).toBe('done');
  });

  test('done branch 5: agent is "kiro" with empty md and null log', () => {
    expect(detectStatus('', null, 'kiro')).toBe('done');
  });

  // reported branch
  test('reported: log (not md) contains "[agenthq] done in"', () => {
    expect(detectStatus('', '[agenthq] done in 30s', 'agenthq')).toBe('reported');
  });

  // running branch
  test('running: no done/reported/error markers anywhere', () => {
    expect(detectStatus('Some progress notes', null, 'agenthq')).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// extractAgentDone
// ---------------------------------------------------------------------------

describe('extractAgentDone', () => {
  test('returns the [agenthq] done line', () => {
    const md = 'Some text\n[agenthq] done in 12.3s\nMore text';
    expect(extractAgentDone(md)).toBe('[agenthq] done in 12.3s');
  });

  test('returns the [goose_recipe_worker] Done line', () => {
    const md = 'Preamble\n[goose_recipe_worker] Done processing recipe\nEpilogue';
    expect(extractAgentDone(md)).toBe('[goose_recipe_worker] Done processing recipe');
  });

  test('returns empty string when neither pattern is present', () => {
    expect(extractAgentDone('Nothing interesting here')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractSessionChainId
// ---------------------------------------------------------------------------

describe('extractSessionChainId', () => {
  test('timestamp+chainId pattern: /sessions/2026-06-22_abc123/ → "abc123"', () => {
    expect(extractSessionChainId('/sessions/2026-06-22_abc123/state.json')).toBe('abc123');
  });

  test('bare chainId pattern: /sessions/chainABC/ → "chainABC"', () => {
    expect(extractSessionChainId('/sessions/chainABC/state.json')).toBe('chainABC');
  });

  test('orphan pattern: /_orphan-chains/orphan-id → "orphan-id"', () => {
    expect(extractSessionChainId('/_orphan-chains/orphan-id')).toBe('orphan-id');
  });

  test('no match returns empty string', () => {
    expect(extractSessionChainId('/some/other/path')).toBe('');
  });
});
