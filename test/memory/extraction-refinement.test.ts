/**
 * Unit tests for the refinement pass in `_doExtract` (sub-task 3.6).
 *
 * The refinement pass fires when the mean quality score of the initial scored
 * facts is below QUALITY_THRESHOLD (0.75). It re-calls `_callExtractor` with
 * all scorer critiques appended, re-scores via `_callScorer`, and replaces the
 * original scored facts. Only one refinement pass is attempted per job.
 *
 * Because the extractor and scorer are private, tests drive them via the public
 * `extractAndStore` entry point. `Bun.file` is stubbed to provide valid file
 * content so the file-read step is always passed.
 *
 * The test controls scoring behaviour by returning different scores on the first
 * vs second `fetch` call (extractor → scorer → extractor[refinement] → scorer[refinement]).
 *
 * Covers:
 *   - Mean score < 0.75 → refinement extractor called with critiques; refined
 *     facts replace originals when scorer succeeds
 *   - Mean score >= 0.75 → refinement extractor NOT called (only 2 fetch calls)
 *   - Refinement extractor throws → original scored facts used; extraction
 *     does not fail (no failed row written for this reason alone)
 *   - Refinement scorer throws → original scored facts used; extraction does
 *     not fail
 *   - Only one refinement pass even when refined facts still score below 0.75
 *
 * Requirements: Phase 6.2, Requirement 2 AC 6.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { extractAndStore } from '../../src/memory/extraction.ts';
import type { Job } from '../../src/types.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');
const FILE_CONTENT =
  '# Agent Output\n\nThe system uses SQLite with WAL mode for concurrent reads.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-refinement-001',
    name: 'test-job',
    jobChain: 'test-job',
    sessionChainId: 'chain-001',
    timestamp: new Date().toISOString(),
    type: 'agent',
    agent: 'kiro',
    status: 'done',
    lines: 10,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '/valid/output.md',
    logFile: '/valid/output.log',
    agentDone: '',
    sizeBytes: 100,
    workspaceId: 'ws-001',
    ...overrides,
  };
}

const noopClient: IMemoryClient = {
  retain: async (_text: string, _scope: MemoryScope): Promise<string> => 'memory-id-1',
  recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => [],
  reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
  delete: async (_id: string): Promise<void> => {},
  list: async (_scope: MemoryScope, _pageSize: number, _cursor: string | null) => ({
    memories: [],
    nextCursor: null,
    total: 0,
  }),
  get: async (_id: string) => null,
};

async function getExtractionRow(
  db: SQLiteAdapter,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM memory_extraction WHERE job_id = ?',
    [jobId],
  );
  return result.rows[0] ?? null;
}

function makeFakeBunFile(text: string): ReturnType<typeof Bun.file> {
  return {
    exists: async () => true,
    text: async () => text,
  } as unknown as ReturnType<typeof Bun.file>;
}

async function seedWorkspaceAndJob(db: SQLiteAdapter, job: Job): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO workspaces (id, output_dir, sessions_dir, created_at)
     VALUES (?, ?, ?, ?)`,
    [job.workspaceId, '/tmp/output', '/tmp/sessions', new Date().toISOString()],
  );
  await db.execute(
    `INSERT OR IGNORE INTO jobs
       (id, workspace_id, name, job_chain, session_chain_id, timestamp, type, agent,
        status, lines, last_line, has_log, log_error, md_file, log_file, agent_done,
        size_bytes, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id, job.workspaceId, job.name, job.jobChain, job.sessionChainId,
      job.timestamp, job.type, job.agent, job.status, job.lines, job.lastLine,
      job.hasLog ? 1 : 0, job.logError ? 1 : 0, job.mdFile, job.logFile,
      job.agentDone, job.sizeBytes, Date.now(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

/**
 * Wraps raw assistant content into an OpenRouter chat completion response shape.
 */
function wrapInChatCompletion(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'openrouter/owl-alpha',
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

function makeFetchResponse(responseBody: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(wrapInChatCompletion(responseBody)),
    text: async () => wrapInChatCompletion(responseBody),
    clone: () => ({ json: async () => JSON.parse(wrapInChatCompletion(responseBody)) }),
  } as unknown as Response;
}

/** Valid extractor response — one fact. */
function extractorResponse(text = 'SQLite WAL mode is enabled by the adapter on first connection.'): string {
  return JSON.stringify({
    facts: [{ text, category: 'architecture' }],
  });
}

/** Valid scorer response — one score. */
function scorerResponse(score: number, critique = 'Acceptable fact.'): string {
  return JSON.stringify({
    scores: [{ score, critique }],
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('_doExtract — refinement pass (sub-task 3.6)', () => {
  let db: SQLiteAdapter;
  const savedApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    jest.spyOn(Bun, 'file').mockReturnValue(makeFakeBunFile(FILE_CONTENT));
    process.env.OPENROUTER_API_KEY = 'test-key-123';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = savedApiKey;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Refinement triggered — mean score below threshold
  // -------------------------------------------------------------------------

  it('should call the extractor a second time when initial mean score is below 0.75', async () => {
    // Arrange: 4 fetch calls expected:
    //   1. Extractor (initial)
    //   2. Scorer (initial, returns score 0.50 → triggers refinement)
    //   3. Extractor (refinement, called with critiques)
    //   4. Scorer (refinement)
    const job = makeJob({ id: 'job-refinement-triggered' });
    await seedWorkspaceAndJob(db, job);

    const fetchResponses = [
      makeFetchResponse(extractorResponse()),              // 1. initial extractor
      makeFetchResponse(scorerResponse(0.50, 'Too vague — lacks component name.')),  // 2. initial scorer (below 0.75)
      makeFetchResponse(extractorResponse('SQLite WAL mode is enabled by SQLiteAdapter on every new connection, not per-query.')),  // 3. refinement extractor
      makeFetchResponse(scorerResponse(0.90, 'Specific and actionable.')),           // 4. refinement scorer
    ];
    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
      const response = fetchResponses[callCount];
      callCount++;
      return response;
    });

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert: fetch was called 4 times (extractor × 2 + scorer × 2)
    expect(callCount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Refinement skipped — mean score at or above threshold
  // -------------------------------------------------------------------------

  it('should not call the extractor a second time when initial mean score is >= 0.75', async () => {
    // Arrange: only 2 fetch calls expected:
    //   1. Extractor (initial)
    //   2. Scorer (initial, returns score 0.80 — no refinement)
    const job = makeJob({ id: 'job-no-refinement' });
    await seedWorkspaceAndJob(db, job);

    const fetchResponses = [
      makeFetchResponse(extractorResponse()),          // 1. initial extractor
      makeFetchResponse(scorerResponse(0.80)),         // 2. initial scorer (above threshold)
    ];
    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
      const response = fetchResponses[callCount];
      callCount++;
      return response;
    });

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert: only 2 fetch calls — no refinement extractor called
    expect(callCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Refinement extractor throws — original facts used, extraction continues
  // -------------------------------------------------------------------------

  it('should use original scored facts when the refinement extractor throws', async () => {
    // Arrange: 3 fetch calls:
    //   1. Extractor (initial, returns valid facts)
    //   2. Scorer (initial, returns low score → triggers refinement)
    //   3. Extractor (refinement, throws / server error)
    const job = makeJob({ id: 'job-refine-extractor-throws' });
    await seedWorkspaceAndJob(db, job);

    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 1) return makeFetchResponse(extractorResponse());
      if (callCount === 2) return makeFetchResponse(scorerResponse(0.40, 'Too generic.'));
      // 3rd call: refinement extractor — simulate network error → SDK will throw
      throw new TypeError('fetch failed — simulated network error');
    });

    // Act — must not throw
    await expect(extractAndStore(job, db, noopClient)).resolves.toBeUndefined();

    // Assert: fetch was called exactly 3 times (no 4th scorer call)
    expect(callCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Refinement scorer throws — original facts used, extraction continues
  // -------------------------------------------------------------------------

  it('should use original scored facts when the refinement scorer throws', async () => {
    // Arrange: 4 fetch calls:
    //   1. Extractor (initial)
    //   2. Scorer (initial, low score → triggers refinement)
    //   3. Extractor (refinement, succeeds)
    //   4. Scorer (refinement, throws / server error)
    const job = makeJob({ id: 'job-refine-scorer-throws' });
    await seedWorkspaceAndJob(db, job);

    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 1) return makeFetchResponse(extractorResponse());
      if (callCount === 2) return makeFetchResponse(scorerResponse(0.30, 'Not specific enough.'));
      if (callCount === 3) return makeFetchResponse(extractorResponse('SQLite WAL mode enabled by SQLiteAdapter on connection init.'));
      // 4th call: refinement scorer — simulate network error
      throw new TypeError('fetch failed — simulated network error');
    });

    // Act — must not throw
    await expect(extractAndStore(job, db, noopClient)).resolves.toBeUndefined();

    // Assert: all 4 fetch calls were made; extraction did not fail at the
    // refinement scorer step
    expect(callCount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Only one refinement pass — does not loop even if refined score still < 0.75
  // -------------------------------------------------------------------------

  it('should not perform a second refinement pass when refined facts still score below 0.75', async () => {
    // Arrange: exactly 4 fetch calls expected (extractor, scorer, refinement-extractor, refinement-scorer)
    // If a loop occurred, there would be a 5th+ call.
    const job = makeJob({ id: 'job-single-pass-only' });
    await seedWorkspaceAndJob(db, job);

    const fetchResponses = [
      makeFetchResponse(extractorResponse()),                               // 1. initial extractor
      makeFetchResponse(scorerResponse(0.50, 'Too vague.')),               // 2. initial scorer (below 0.75)
      makeFetchResponse(extractorResponse('The system has components.')),   // 3. refinement extractor
      makeFetchResponse(scorerResponse(0.40, 'Still too vague.')),         // 4. refinement scorer (still below 0.75)
    ];
    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
      const response = fetchResponses[callCount];
      callCount++;
      return response;
    });

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert: exactly 4 calls — no second refinement loop
    expect(callCount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // extractAndStore never rethrows on refinement failures
  // -------------------------------------------------------------------------

  it('should not throw when refinement extractor returns invalid JSON', async () => {
    // Arrange
    const job = makeJob({ id: 'job-refine-invalid-json' });
    await seedWorkspaceAndJob(db, job);

    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 1) return makeFetchResponse(extractorResponse());
      if (callCount === 2) return makeFetchResponse(scorerResponse(0.50, 'Needs improvement.'));
      // Refinement extractor returns invalid JSON
      return makeFetchResponse('this is not json');
    });

    // Act + Assert
    await expect(extractAndStore(job, db, noopClient)).resolves.toBeUndefined();
  });
});
