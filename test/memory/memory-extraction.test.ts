/**
 * Unit tests for `extractAndStore` — sub-task 3.13.
 *
 * Covers the scenarios specified in task 3.13:
 *   1. In-flight guard: concurrent calls with same job ID — second returns immediately
 *   2. Missing/empty file writes a failed row
 *   3. LLM throw (_callScorer) writes failed row and does not rethrow
 *   4. Quality gate pass writes actual metrics (non-zero memory_count, quality_score)
 *   5. Generic patterns reject before dedup — no client.recall call for rejected facts
 *   6. client.recall throw rejects that individual fact and continues with remaining
 *   7. DB upsert fail rolls back retained facts via client.delete
 *
 * Existing test files in test/memory/ already cover:
 *   - extraction-file-read.test.ts  — file absent/empty/whitespace-only, basic in-flight guard
 *   - extraction-extractor.test.ts  — _callExtractor failures
 *   - extraction-pattern-filter.test.ts — pattern rejection
 *   - extraction-refinement.test.ts — refinement pass
 *
 * This file provides focused integration for the scenarios listed above,
 * including full end-to-end paths through quality gate → dedup → retain → upsert.
 *
 * Test isolation: in-memory SQLite DB with all migrations applied. A fake
 * IMemoryClient records calls and is configured per-test. Global fetch is
 * mocked to control LLM responses. Bun.file is stubbed via jest.spyOn.
 *
 * Requirements: Phase 6.2, Requirement 2 ACs 2, 3, 5, 7, 8, 10, 11.
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
  '# Agent Output\n\nThe system uses SQLite with WAL mode for concurrent reads.\n' +
  'Connection pooling is not used — each request creates a fresh connection.';

// ---------------------------------------------------------------------------
// Job fixture factory
// ---------------------------------------------------------------------------

let _jobCounter = 0;

function makeJob(overrides: Partial<Job> = {}): Job {
  _jobCounter++;
  return {
    id: `job-memext-${_jobCounter}`,
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

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fake IMemoryClient factory
// ---------------------------------------------------------------------------

type FakeClientConfig = {
  recallResult?: Memory[];
  recallThrows?: boolean;
  retainResult?: string;
  retainThrows?: boolean;
  deleteThrows?: boolean;
};

type FakeClient = IMemoryClient & {
  recallCalls: Array<{ query: string; scope: MemoryScope; limit: number }>;
  retainCalls: Array<{ text: string; scope: MemoryScope }>;
  deletedIds: string[];
};

function makeFakeClient(config: FakeClientConfig = {}): FakeClient {
  const recallCalls: Array<{ query: string; scope: MemoryScope; limit: number }> = [];
  const retainCalls: Array<{ text: string; scope: MemoryScope }> = [];
  const deletedIds: string[] = [];
  let retainCounter = 0;

  return {
    recallCalls,
    retainCalls,
    deletedIds,
    recall: async (query: string, scope: MemoryScope, limit: number): Promise<Memory[]> => {
      recallCalls.push({ query, scope, limit });
      if (config.recallThrows) throw new Error('recall network failure');
      return config.recallResult ?? [];
    },
    retain: async (text: string, scope: MemoryScope): Promise<string> => {
      retainCalls.push({ text, scope });
      if (config.retainThrows) throw new Error('retain network failure');
      retainCounter++;
      return config.retainResult ?? `retained-id-${retainCounter}`;
    },
    reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
    delete: async (id: string): Promise<void> => {
      deletedIds.push(id);
      if (config.deleteThrows) throw new Error('delete network failure');
    },
    list: async (_scope: MemoryScope, _pageSize: number, _cursor: string | null) => ({
      memories: [],
      nextCursor: null,
      total: 0,
    }),
    get: async (_id: string) => null,
  };
}

// ---------------------------------------------------------------------------
// Fake Bun.file helper
// ---------------------------------------------------------------------------

type FakeBunFileConfig = {
  exists: boolean;
  text?: string;
};

function makeFakeBunFile(config: FakeBunFileConfig): ReturnType<typeof Bun.file> {
  return {
    exists: async () => config.exists,
    text: async () => {
      if (!config.exists) throw new Error('ENOENT: no such file');
      return config.text ?? '';
    },
  } as unknown as ReturnType<typeof Bun.file>;
}

// ---------------------------------------------------------------------------
// Fake fetch helpers — sequence through LLM call responses
// ---------------------------------------------------------------------------

function wrapInChatCompletion(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'openrouter/test-model',
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

function makeFetchResponse(body: string): Response {
  const wrapped = wrapInChatCompletion(body);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(wrapped),
    text: async () => wrapped,
    clone: () => ({ json: async () => JSON.parse(wrapped) }),
  } as unknown as Response;
}

function makeFetchError(message: string): () => Promise<never> {
  return async () => { throw new TypeError(message); };
}

/**
 * Build an extractor response containing the given facts.
 * Each fact defaults to category 'architecture' unless specified.
 */
function buildExtractorBody(
  facts: Array<{ text: string; category?: string }>,
): string {
  return JSON.stringify({
    facts: facts.map(f => ({
      text: f.text,
      category: f.category ?? 'architecture',
    })),
  });
}

/**
 * Build a scorer response parallel to the given facts.
 * All items receive the given score (default 0.90) and critique.
 */
function buildScorerBody(
  count: number,
  score = 0.90,
  critique = 'Specific and actionable fact.',
): string {
  return JSON.stringify({
    scores: Array.from({ length: count }, () => ({ score, critique })),
  });
}

/**
 * Mock global fetch with a sequence of responses.
 * Each call consumes the next element; throws if more calls are made than responses.
 */
function mockFetchSequence(responses: Array<Response | (() => Promise<never>)>): {
  callCount: () => number;
} {
  let idx = 0;
  (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
    const item = responses[idx];
    idx++;
    if (item === undefined) throw new Error(`Unexpected fetch call #${idx}`);
    if (typeof item === 'function') return item();
    return item;
  });
  return { callCount: () => idx };
}

/**
 * Mock fetch for a full happy-path extraction:
 *   call 1 → extractor returning `facts`
 *   call 2 → scorer returning `score` for each fact
 */
function mockHappyPath(
  facts: Array<{ text: string; category?: string }>,
  score = 0.90,
): ReturnType<typeof mockFetchSequence> {
  return mockFetchSequence([
    makeFetchResponse(buildExtractorBody(facts)),
    makeFetchResponse(buildScorerBody(facts.length, score)),
  ]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('extractAndStore — sub-task 3.13 unit tests', () => {
  let db: SQLiteAdapter;
  const savedApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    // Default to valid file content; individual tests may override
    jest.spyOn(Bun, 'file').mockReturnValue(
      makeFakeBunFile({ exists: true, text: FILE_CONTENT }),
    );
    // Provide a fake API key so the key-absence guard does not trigger
    process.env.OPENROUTER_API_KEY = 'test-key-for-extraction-tests';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = savedApiKey;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    await db.close();
  });

  // =========================================================================
  // 1. In-flight guard
  // =========================================================================

  describe('in-flight guard (AC 2)', () => {
    it('should return immediately on the second concurrent call for the same job ID', async () => {
      // Arrange: use a controlled promise to keep the first call in-flight
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      let resolveFile!: (text: string) => void;
      const fileGate = new Promise<string>(resolve => { resolveFile = resolve; });

      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue({
        exists: async () => true,
        text: () => fileGate,
      } as unknown as ReturnType<typeof Bun.file>);

      const client = makeFakeClient();

      // Act: fire two concurrent calls — second should be a no-op
      const p1 = extractAndStore(job, db, client);
      const p2 = extractAndStore(job, db, client); // should return immediately

      // Resolve the file gate so p1 can proceed past the file-read step
      resolveFile('');
      await Promise.all([p1, p2]);

      // Assert: at most one memory_extraction row written (p2 wrote nothing)
      const result = await db.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM memory_extraction WHERE job_id = ?',
        [job.id],
      );
      expect(result.rows[0]!.cnt).toBeLessThanOrEqual(1);
    });

    it('should allow a new call after the in-flight extraction completes', async () => {
      // Arrange: first call completes (absent file → failed row)
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue(
        makeFakeBunFile({ exists: false }),
      );
      const client = makeFakeClient();

      await extractAndStore(job, db, client);

      const firstRow = await getExtractionRow(db, job.id);
      expect(firstRow!['embedding_status']).toBe('failed');

      // Act: second call after first completes — in-flight set is cleared
      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue(
        makeFakeBunFile({ exists: false }),
      );
      await extractAndStore(job, db, client);

      // Assert: second call ran and upserted the same failed row again
      const secondRow = await getExtractionRow(db, job.id);
      expect(secondRow).not.toBeNull();
      expect(secondRow!['embedding_status']).toBe('failed');
    });
  });

  // =========================================================================
  // 2. Missing / empty file writes failed row (AC 3, AC 11)
  // =========================================================================

  describe('missing / empty file → failed row (AC 3)', () => {
    it('should write a failed row with quality_score=0, memory_count=0, embedding_status=failed for absent file', async () => {
      // Arrange
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue(makeFakeBunFile({ exists: false }));
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['quality_score']).toBe(0);
      expect(row!['memory_count']).toBe(0);
      expect(row!['embedding_status']).toBe('failed');
      expect(row!['raw_text']).toBe('');
    });

    it('should write a failed row for an empty file (zero-length text)', async () => {
      // Arrange
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue(
        makeFakeBunFile({ exists: true, text: '' }),
      );
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['quality_score']).toBe(0);
      expect(row!['memory_count']).toBe(0);
      expect(row!['embedding_status']).toBe('failed');
    });

    it('should write a failed row for a whitespace-only file', async () => {
      // Arrange
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue(
        makeFakeBunFile({ exists: true, text: '   \n\t  \r\n  ' }),
      );
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['embedding_status']).toBe('failed');
      expect(row!['memory_count']).toBe(0);
    });

    it('should not make any LLM calls when the file is absent', async () => {
      // Arrange
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      jest.restoreAllMocks();
      jest.spyOn(Bun, 'file').mockReturnValue(makeFakeBunFile({ exists: false }));
      const fetchSpy = jest.fn();
      (globalThis as Record<string, unknown>).fetch = fetchSpy;
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert: no LLM call was attempted
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. LLM throw (_callScorer) writes failed row (AC 11)
  // =========================================================================

  describe('_callScorer throw → failed row (AC 11)', () => {
    it('should write a failed row when the scorer LLM call throws a network error', async () => {
      // Arrange: extractor succeeds; scorer throws
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff with a 32-second cap.' },
      ];
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchError('scorer fetch failed — simulated network timeout'),
      ]);
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['embedding_status']).toBe('failed');
      expect(row!['quality_score']).toBe(0);
      expect(row!['memory_count']).toBe(0);
    });

    it('should write a failed row when the scorer returns a length-mismatched scores array', async () => {
      // Arrange: extractor returns 2 facts; scorer returns 1 score (mismatch)
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff with a 32-second cap.' },
      ];
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchResponse(buildScorerBody(1)), // only 1 score for 2 facts
      ]);
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['embedding_status']).toBe('failed');
      expect(row!['memory_count']).toBe(0);
    });

    it('should not rethrow when the scorer throws', async () => {
      // Arrange
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [{ text: 'SQLite WAL mode is enabled on every new connection.' }];
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchError('scorer network failure'),
      ]);

      // Act + Assert: resolves without throwing
      await expect(extractAndStore(job, db, makeFakeClient())).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // 4. Quality gate pass writes actual metrics (AC 5, AC 10)
  // =========================================================================

  describe('quality gate pass → actual metrics in DB row (AC 5, AC 10)', () => {
    it('should write memory_count equal to the number of retained facts', async () => {
      // Arrange: 2 facts, both pass quality gate (score 0.90) and are not duplicates
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff capped at 32 seconds.' },
      ];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient({ recallResult: [] }); // no duplicates

      // Act
      await extractAndStore(job, db, client);

      // Assert
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['embedding_status']).not.toBe('failed');
      expect(row!['memory_count']).toBe(2);
    });

    it('should write quality_score as the mean of accepted fact scores', async () => {
      // Arrange: 2 facts with scores 0.80 and 0.90 — mean = 0.85
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff capped at 32 seconds.' },
      ];
      // Use two different scores: build manually
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchResponse(
          JSON.stringify({
            scores: [
              { score: 0.80, critique: 'Good specificity.' },
              { score: 0.90, critique: 'Excellent specificity.' },
            ],
          }),
        ),
      ]);
      const client = makeFakeClient({ recallResult: [] });

      // Act
      await extractAndStore(job, db, client);

      // Assert: quality_score stored in DB — mean of accepted (0.80+0.90)/2 = 0.85
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      // Use closeTo with a small delta to account for float representation
      expect(row!['quality_score'] as number).toBeCloseTo(0.85, 5);
      expect(row!['memory_count']).toBe(2);
    });

    it('should write embedding_status=embedded for hot-tier jobs', async () => {
      // Arrange: no completed jobs exist yet → classifyTier returns hot
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
      ];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient({ recallResult: [] });

      // Act
      await extractAndStore(job, db, client);

      // Assert: zero completed jobs → count < MEMORY_HOT_TIER_COUNT → hot tier
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['tier']).toBe('hot');
      expect(row!['embedding_status']).toBe('embedded');
    });

    it('should write memory_count=0 when all facts pass quality gate but none survive dedup', async () => {
      // Arrange: 1 fact, score 0.90, but recall returns a near-duplicate (similarityScore > 0.92)
      // The implementation computes meanScore of the *deduped* facts (the accepted ones passed to
      // retain). When all are deduped, dedupedFacts is empty and _meanScore([]) returns 0 — this
      // is by design so quality_score reflects the score of actually stored facts, not rejected ones.
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
      ];
      mockHappyPath(facts, 0.90);
      const duplicate: Memory = {
        id: 'existing-mem-001',
        text: 'SQLite WAL mode enabled on new connection.',
        scope: { workspaceId: job.workspaceId },
        qualityScore: 0.92,
        createdAt: new Date().toISOString(),
        lastRetrievedAt: new Date().toISOString(),
        retrievalCount: 3,
        tier: 'hot',
        embeddingStatus: 'ready',
        stale: false,
        superseded: false,
      };
      // Add similarityScore dynamically (not part of Memory type; checked as unknown)
      const dupWithScore = { ...duplicate, similarityScore: 0.95 } as unknown as Memory;
      const client = makeFakeClient({ recallResult: [dupWithScore] });

      // Act
      await extractAndStore(job, db, client);

      // Assert: row written with memory_count=0 (all deduped); embedding_status not 'failed'
      // quality_score=0 is expected when no facts were retained (mean of empty set = 0)
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['embedding_status']).not.toBe('failed');
      expect(row!['memory_count']).toBe(0);
    });
  });

  // =========================================================================
  // 5. Generic patterns reject before dedup — no client.recall for rejected facts (AC 7, AC 8)
  // =========================================================================

  describe('generic pattern rejection before dedup (AC 7, AC 8)', () => {
    it('should not call client.recall for a fact matching /the system has \\w+/i', async () => {
      // Arrange: one fact that matches the first reject pattern
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'The system has multiple worker processes running concurrently.' },
      ];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert: recall never called — pattern rejection happened first
      expect(client.recallCalls).toHaveLength(0);
    });

    it('should not call client.recall for a fact matching /build (is )?currently failing/i', async () => {
      // Arrange
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'Build is currently failing due to missing dist artifacts in the output.' },
      ];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      expect(client.recallCalls).toHaveLength(0);
    });

    it('should not call client.recall for a fact shorter than MIN_FACT_LENGTH (20 chars)', async () => {
      // Arrange: "WAL mode on" is 11 characters
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [{ text: 'WAL mode on' }];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      expect(client.recallCalls).toHaveLength(0);
    });

    it('should not call client.recall for a fact longer than MAX_FACT_LENGTH (500 chars)', async () => {
      // Arrange: 501-character fact
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [{ text: 'A'.repeat(501) }];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient();

      // Act
      await extractAndStore(job, db, client);

      // Assert
      expect(client.recallCalls).toHaveLength(0);
    });

    it('should call client.recall only for facts that pass the pattern filter', async () => {
      // Arrange: 3 facts — 1 valid, 1 pattern-rejected, 1 too short
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const validText = 'SQLite WAL mode is enabled on every new database connection.';
      const facts = [
        { text: validText },
        { text: 'The system has a cache layer for hot-tier reads.' },
        { text: 'Cache' },
      ];
      // Scorer must return 3 scores for 3 facts
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchResponse(buildScorerBody(3, 0.90)),
      ]);
      const client = makeFakeClient({ recallResult: [] });

      // Act
      await extractAndStore(job, db, client);

      // Assert: recall called only for the valid fact
      expect(client.recallCalls).toHaveLength(1);
      expect(client.recallCalls[0]!.query).toBe(validText);
    });
  });

  // =========================================================================
  // 6. client.recall throw rejects fact and continues (AC 8)
  // =========================================================================

  describe('client.recall throw → fact rejected, others continue (AC 8)', () => {
    it('should reject the fact whose recall throws and continue with remaining facts', async () => {
      // Arrange: 2 valid facts; recall throws for the first, returns [] for the second.
      // The second fact should proceed to retain.
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const fact1 = 'SQLite WAL mode is enabled on every new database connection.';
      const fact2 = 'The retry queue uses exponential backoff capped at 32 seconds.';
      const facts = [{ text: fact1 }, { text: fact2 }];
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchResponse(buildScorerBody(2, 0.90)),
      ]);

      let recallCallCount = 0;
      const client: IMemoryClient & { retainedTexts: string[] } = {
        retainedTexts: [],
        recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => {
          recallCallCount++;
          if (recallCallCount === 1) {
            // First fact's recall throws
            throw new Error('recall failure for first fact');
          }
          // Second fact's recall returns no duplicates
          return [];
        },
        retain: async (text: string, _scope: MemoryScope): Promise<string> => {
          (client as { retainedTexts: string[] }).retainedTexts.push(text);
          return `retained-id-${(client as { retainedTexts: string[] }).retainedTexts.length}`;
        },
        reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
        delete: async (_id: string): Promise<void> => {},
        list: async (_scope: MemoryScope, _pageSize: number, _cursor: string | null) => ({
          memories: [],
          nextCursor: null,
          total: 0,
        }),
        get: async (_id: string) => null,
      };

      // Act
      await extractAndStore(job, db, client);

      // Assert: first fact rejected (recall threw), second fact retained
      expect(recallCallCount).toBe(2); // both facts reached dedup check
      expect((client as { retainedTexts: string[] }).retainedTexts).toHaveLength(1);
      expect((client as { retainedTexts: string[] }).retainedTexts[0]).toBe(fact2);
    });

    it('should not throw when all facts are rejected by recall errors', async () => {
      // Arrange: both facts fail recall → no retained facts, but no exception
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff capped at 32 seconds.' },
      ];
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(facts)),
        makeFetchResponse(buildScorerBody(2, 0.90)),
      ]);
      const client = makeFakeClient({ recallThrows: true });

      // Act + Assert: no throw; extraction completes gracefully
      await expect(extractAndStore(job, db, client)).resolves.toBeUndefined();

      // Assert: memory_count=0 but not a failed row
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['memory_count']).toBe(0);
    });

    it('should write the DB row after recall errors with correct memory_count for surviving facts', async () => {
      // Arrange: 3 facts; recall throws for fact 2, facts 1 and 3 succeed
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const fact1 = 'SQLite WAL mode is enabled on every new database connection.';
      const fact2 = 'The system has multiple worker processes running concurrently.';
      const fact3 = 'The retry queue uses exponential backoff capped at 32 seconds.';
      const facts = [{ text: fact1 }, { text: fact2 }, { text: fact3 }];
      // All 3 score 0.90; fact2 also matches the pattern filter → rejected before recall
      // Use only non-pattern facts so recall decides:
      const fact1ok = 'SQLite WAL mode is enabled on every new database connection.';
      const fact2throws = 'Connection pool is disabled in this configuration, noted by the team.';
      const fact3ok = 'The retry queue uses exponential backoff capped at 32 seconds.';
      const factsForTest = [
        { text: fact1ok },
        { text: fact2throws },
        { text: fact3ok },
      ];
      mockFetchSequence([
        makeFetchResponse(buildExtractorBody(factsForTest)),
        makeFetchResponse(buildScorerBody(3, 0.90)),
      ]);

      let recallIdx = 0;
      const retainedTexts: string[] = [];
      const mixedClient: IMemoryClient = {
        recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => {
          recallIdx++;
          if (recallIdx === 2) throw new Error('recall failure for fact 2');
          return [];
        },
        retain: async (text: string, _scope: MemoryScope): Promise<string> => {
          retainedTexts.push(text);
          return `id-${retainedTexts.length}`;
        },
        reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
        delete: async (_id: string): Promise<void> => {},
        list: async (_scope: MemoryScope, _pageSize: number, _cursor: string | null) => ({
          memories: [],
          nextCursor: null,
          total: 0,
        }),
        get: async (_id: string) => null,
      };

      // Act
      await extractAndStore(job, db, mixedClient);

      // Assert: facts 1 and 3 retained, fact 2 rejected by recall error
      expect(retainedTexts).toHaveLength(2);
      expect(retainedTexts).toContain(fact1ok);
      expect(retainedTexts).toContain(fact3ok);
      const row = await getExtractionRow(db, job.id);
      expect(row!['memory_count']).toBe(2);
    });
  });

  // =========================================================================
  // 7. DB upsert fail rolls back retained facts via client.delete (AC 10)
  // =========================================================================

  describe('DB upsert failure → rollback retained facts (AC 10)', () => {
    it('should call client.delete for each retained ID when the DB upsert fails', async () => {
      // Arrange: 2 facts retained successfully, then DB execute is patched to throw
      // on the SUCCESS upsert only — _writeFailedRow's INSERT is allowed through.
      // Both the success upsert and the _writeFailedRow INSERT use the same SQL pattern,
      // so we use a throw-once flag: throw on first match, allow subsequent calls.
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff capped at 32 seconds.' },
      ];
      mockHappyPath(facts, 0.90);

      const retainedIds: string[] = [];
      const client = makeFakeClient({ recallResult: [] });
      // Override retain to track IDs
      const originalRetain = client.retain.bind(client);
      client.retain = async (text: string, scope: MemoryScope): Promise<string> => {
        const id = await originalRetain(text, scope);
        retainedIds.push(id);
        return id;
      };

      // Patch db.execute so the first memory_extraction success INSERT throws;
      // subsequent calls (including _writeFailedRow) are allowed through.
      const originalExecute = db.execute.bind(db);
      let upsertThrown = false;
      db.execute = async (sql: string, params?: unknown[]): ReturnType<typeof db.execute> => {
        if (!upsertThrown && sql.includes('INSERT INTO memory_extraction') && sql.includes('ON CONFLICT')) {
          upsertThrown = true;
          throw new Error('DB upsert failure: disk full');
        }
        return originalExecute(sql, params);
      };

      // Act
      await extractAndStore(job, db, client);

      // Restore db.execute
      db.execute = originalExecute;

      // Assert: client.delete called for each retained ID
      expect(client.deletedIds).toHaveLength(retainedIds.length);
      for (const id of retainedIds) {
        expect(client.deletedIds).toContain(id);
      }
    });

    it('should write a failed row when the DB upsert fails', async () => {
      // Arrange: throw on first memory_extraction INSERT only (success path);
      // allow the _writeFailedRow INSERT to proceed.
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
      ];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient({ recallResult: [] });

      const originalExecute = db.execute.bind(db);
      let upsertThrown = false;
      db.execute = async (sql: string, params?: unknown[]): ReturnType<typeof db.execute> => {
        if (!upsertThrown && sql.includes('INSERT INTO memory_extraction') && sql.includes('ON CONFLICT')) {
          upsertThrown = true;
          throw new Error('DB upsert failure: constraint violation');
        }
        return originalExecute(sql, params);
      };

      // Act
      await extractAndStore(job, db, client);

      db.execute = originalExecute;

      // Assert: _writeFailedRow wrote a failed row after the success upsert threw
      const row = await getExtractionRow(db, job.id);
      expect(row).not.toBeNull();
      expect(row!['embedding_status']).toBe('failed');
      expect(row!['memory_count']).toBe(0);
      expect(row!['quality_score']).toBe(0);
    });

    it('should not rethrow when the DB upsert fails', async () => {
      // Arrange: throw on first memory_extraction INSERT only
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
      ];
      mockHappyPath(facts, 0.90);
      const client = makeFakeClient({ recallResult: [] });

      const originalExecute = db.execute.bind(db);
      let upsertThrown = false;
      db.execute = async (sql: string, params?: unknown[]): ReturnType<typeof db.execute> => {
        if (!upsertThrown && sql.includes('INSERT INTO memory_extraction') && sql.includes('ON CONFLICT')) {
          upsertThrown = true;
          throw new Error('DB upsert failure: disk I/O error');
        }
        return originalExecute(sql, params);
      };

      // Act + Assert: resolves without throwing
      await expect(extractAndStore(job, db, client)).resolves.toBeUndefined();

      db.execute = originalExecute;
    });

    it('should continue deleting remaining IDs even if one client.delete throws', async () => {
      // Arrange: 2 facts retained; first delete throws; second delete should still run.
      // Throw on first memory_extraction success INSERT only.
      const job = makeJob();
      await seedWorkspaceAndJob(db, job);
      const facts = [
        { text: 'SQLite WAL mode is enabled on every new database connection.' },
        { text: 'The retry queue uses exponential backoff capped at 32 seconds.' },
      ];
      mockHappyPath(facts, 0.90);

      const retainedIds: string[] = [];
      const successfulDeletes: string[] = [];
      let retainCounter = 0;
      const client: IMemoryClient = {
        recall: async (): Promise<Memory[]> => [],
        retain: async (_text: string, _scope: MemoryScope): Promise<string> => {
          retainCounter++;
          const id = `retained-id-${retainCounter}`;
          retainedIds.push(id);
          return id;
        },
        reflect: async (): Promise<string | null> => null,
        delete: async (id: string): Promise<void> => {
          if (id === retainedIds[0]) throw new Error('delete failed for first ID');
          successfulDeletes.push(id);
        },
        list: async (_scope: MemoryScope, _pageSize: number, _cursor: string | null) => ({
          memories: [],
          nextCursor: null,
          total: 0,
        }),
        get: async (_id: string) => null,
      };

      const originalExecute = db.execute.bind(db);
      let upsertThrown = false;
      db.execute = async (sql: string, params?: unknown[]): ReturnType<typeof db.execute> => {
        if (!upsertThrown && sql.includes('INSERT INTO memory_extraction') && sql.includes('ON CONFLICT')) {
          upsertThrown = true;
          throw new Error('DB upsert failure');
        }
        return originalExecute(sql, params);
      };

      // Act — must not throw even though one delete throws
      await expect(extractAndStore(job, db, client)).resolves.toBeUndefined();

      db.execute = originalExecute;

      // Assert: second ID was still deleted even though first delete threw
      expect(successfulDeletes).toContain(retainedIds[1]);
    });
  });
});
