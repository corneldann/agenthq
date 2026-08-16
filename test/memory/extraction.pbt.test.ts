/**
 * Property-based tests for `extractAndStore` — sub-task 3.14.
 *
 * Uses fast-check (`fc`) to verify universal properties that must hold across
 * arbitrary inputs:
 *
 *   P1. **Reject-pattern facts always rejected regardless of score**
 *       Any fact whose text matches a generic reject pattern, is shorter than
 *       MIN_FACT_LENGTH (20), or is longer than MAX_FACT_LENGTH (500) must
 *       never appear in the retained set — regardless of the quality score
 *       assigned by the scorer.
 *
 *   P2. **`memory_count` equals retained ID count**
 *       The `memory_count` column in the `memory_extraction` DB row always
 *       equals the number of IDs returned by `client.retain` calls.
 *
 *   P3. **Mean quality score ∈ [0, 1]**
 *       The `quality_score` field written to the `memory_extraction` DB row is
 *       always a number in [0, 1], regardless of the distribution of input
 *       scorer scores.
 *
 * Validates: Requirements 2.7, 2.9, 2.10
 *
 * Test infrastructure:
 *   - In-memory SQLite DB with all migrations applied.
 *   - Bun.file stubbed to return controlled file content.
 *   - global fetch mocked to return controlled LLM responses.
 *   - Fake IMemoryClient that records retain/delete calls.
 *   - The module-level `_inFlight` Set is cleared between runs via a unique
 *     job ID generated per fc.property iteration.
 */

import { describe, it, beforeEach, afterEach, expect, jest } from 'bun:test';
import * as fc from 'fast-check';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { extractAndStore } from '../../src/memory/extraction.ts';
import type { Job } from '../../src/types.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Constants (mirrors extraction.ts module constants)
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');

/** Must stay in sync with extraction.ts GENERIC_REJECT_PATTERNS */
const GENERIC_REJECT_PATTERNS: RegExp[] = [
  /the system has \w+/i,
  /build (is )?currently failing/i,
];

const MIN_FACT_LENGTH = 20;
const MAX_FACT_LENGTH = 500;
const QUALITY_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Test helper — unique job ID counter (avoids in-flight guard collisions)
// ---------------------------------------------------------------------------

let _jobSeq = 0;

function nextJobId(): string {
  _jobSeq++;
  return `pbt-job-${_jobSeq}`;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: nextJobId(),
    name: 'pbt-test-job',
    jobChain: 'pbt-test-job',
    sessionChainId: 'chain-pbt-001',
    timestamp: new Date().toISOString(),
    type: 'agent',
    agent: 'kiro',
    status: 'done',
    lines: 5,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '/pbt/output.md',
    logFile: '/pbt/output.log',
    agentDone: '',
    sizeBytes: 100,
    workspaceId: 'ws-pbt-001',
    ...overrides,
  };
}

async function seedJob(db: SQLiteAdapter, job: Job): Promise<void> {
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
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM memory_extraction WHERE job_id = ?',
    [jobId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fake IMemoryClient
// ---------------------------------------------------------------------------

type FakeMemoryClient = IMemoryClient & {
  retainedTexts: string[];
  retainedIds: string[];
  deletedIds: string[];
};

function makeFakeClient(): FakeMemoryClient {
  const retainedTexts: string[] = [];
  const retainedIds: string[] = [];
  const deletedIds: string[] = [];
  let seq = 0;

  return {
    retainedTexts,
    retainedIds,
    deletedIds,
    recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => {
      // Always return empty — no dedup rejections, so all facts that pass the
      // pattern filter will reach retain. This isolates the properties we test.
      return [];
    },
    retain: async (text: string, _scope: MemoryScope): Promise<string> => {
      seq++;
      const id = `pbt-retained-${seq}`;
      retainedTexts.push(text);
      retainedIds.push(id);
      return id;
    },
    reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
    delete: async (id: string): Promise<void> => {
      deletedIds.push(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Bun.file — returns valid non-empty content
// ---------------------------------------------------------------------------

const FILE_CONTENT =
  '# Agent Output\n\nSQLite WAL mode is enabled on first connection by the adapter.';

function stubBunFile(): void {
  jest.spyOn(Bun, 'file').mockReturnValue({
    exists: async () => true,
    text: async () => FILE_CONTENT,
  } as unknown as ReturnType<typeof Bun.file>);
}

// ---------------------------------------------------------------------------
// Fake fetch helpers — LLM response builders
// ---------------------------------------------------------------------------

function wrapInChatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-pbt',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'openrouter/pbt-model',
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function makeFetchResponse(responseBody: string): Response {
  const wrapped = wrapInChatCompletion(responseBody);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => wrapped,
    text: async () => JSON.stringify(wrapped),
    clone() {
      return { json: async () => wrapped };
    },
  } as unknown as Response;
}

type FactInput = { text: string; category?: string };

function buildExtractorBody(facts: FactInput[]): string {
  return JSON.stringify({
    facts: facts.map(f => ({
      text: f.text,
      category: f.category ?? 'architecture',
    })),
  });
}

function buildScorerBody(scores: number[]): string {
  return JSON.stringify({
    scores: scores.map(score => ({
      score,
      critique: 'PBT-generated critique.',
    })),
  });
}

/**
 * Configure global fetch to return extractor then scorer responses.
 * For refinement scenarios (mean score < 0.75), an extra extractor+scorer
 * pair is appended — the LLM call budget is generous enough to handle both.
 */
function mockFetchForFacts(facts: FactInput[], scores: number[]): void {
  const extractorResp = makeFetchResponse(buildExtractorBody(facts));
  const scorerResp = makeFetchResponse(buildScorerBody(scores));

  // Refinement pass may trigger 2 extra LLM calls. Reuse the same responses
  // so the mock never runs out of calls to return.
  const responses: Response[] = [
    extractorResp,
    scorerResp,
    // Refinement extractor (same facts — keeps the test deterministic)
    extractorResp,
    // Refinement scorer (same scores)
    scorerResp,
  ];

  let idx = 0;
  (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
    const resp = responses[idx % responses.length];
    idx++;
    return resp;
  });
}

// ---------------------------------------------------------------------------
// Arbitraries — smart generators constrained to the interesting input space
// ---------------------------------------------------------------------------

/** A valid category string as accepted by the extractor. */
const factCategoryArb = fc.constantFrom(
  'architecture',
  'error',
  'resolution',
  'procedure',
  'constraint',
) as fc.Arbitrary<string>;

/**
 * Text that is guaranteed to match one of the GENERIC_REJECT_PATTERNS.
 * Each generator produces a realistic-looking string that contains the
 * pattern token so the pattern rejection logic always fires.
 */
const rejectPatternTextArb = fc.oneof(
  // Pattern 1: /the system has \w+/i
  fc.tuple(
    fc.constantFrom(
      'The system has ',
      'the system has ',
      'THE SYSTEM HAS ',
    ),
    fc.stringMatching(/^[a-z]{3,20}$/), // at least one word-char after "has "
    fc.string({ minLength: 0, maxLength: 40 }),
  ).map(([prefix, word, suffix]) => `${prefix}${word}${suffix}`),

  // Pattern 2: /build (is )?currently failing/i
  fc.tuple(
    fc.constantFrom(
      'Build is currently failing ',
      'build currently failing ',
      'BUILD IS CURRENTLY FAILING ',
    ),
    fc.string({ minLength: 0, maxLength: 40 }),
  ).map(([prefix, suffix]) => `${prefix}${suffix}`),
);

/**
 * Text that is too short to pass the length filter (< 20 chars).
 * Upper bound is 19 to stay strictly below MIN_FACT_LENGTH.
 */
const tooShortTextArb = fc.string({ minLength: 1, maxLength: MIN_FACT_LENGTH - 1 });

/**
 * Text that is too long to pass the length filter (> 500 chars).
 * Lower bound is 501.
 */
const tooLongTextArb = fc.string({ minLength: MAX_FACT_LENGTH + 1, maxLength: MAX_FACT_LENGTH + 100 });

/**
 * Text that is both within [MIN, MAX] length and does NOT match any reject
 * pattern. These facts are expected to reach `client.retain` (given no dedup).
 */
const validFactTextArb = fc.string({
  minLength: MIN_FACT_LENGTH,
  maxLength: MAX_FACT_LENGTH,
}).filter(
  text =>
    !GENERIC_REJECT_PATTERNS.some(p => p.test(text)),
);

/** A score value in [0, 1] as a float. */
const scoreArb = fc.float({ min: 0, max: 1, noNaN: true });

/**
 * A scored fact input: text that will be rejected, paired with an arbitrary
 * quality score. The score is irrelevant to the property — rejection must
 * happen regardless.
 */
type RejectedFactInput = {
  text: string;
  category: string;
  score: number;
};

const rejectPatternFactArb: fc.Arbitrary<RejectedFactInput> = fc.record({
  text: rejectPatternTextArb,
  category: factCategoryArb,
  score: scoreArb,
});

const tooShortFactArb: fc.Arbitrary<RejectedFactInput> = fc.record({
  text: tooShortTextArb,
  category: factCategoryArb,
  score: scoreArb,
});

const tooLongFactArb: fc.Arbitrary<RejectedFactInput> = fc.record({
  text: tooLongTextArb,
  category: factCategoryArb,
  score: scoreArb,
});

/** Any kind of rejectable fact. */
const anyRejectedFactArb: fc.Arbitrary<RejectedFactInput> = fc.oneof(
  rejectPatternFactArb,
  tooShortFactArb,
  tooLongFactArb,
);

/**
 * A valid fact input (passes pattern and length filters) paired with a score.
 * Score is drawn from [0, 1]. The property tests control whether these facts
 * actually reach retain by setting scores above QUALITY_THRESHOLD so no
 * refinement complicates the count invariant.
 */
type ValidFactInput = {
  text: string;
  category: string;
  score: number;
};

const validFactArb: fc.Arbitrary<ValidFactInput> = fc.record({
  text: validFactTextArb,
  category: factCategoryArb,
  // Score above QUALITY_THRESHOLD so all valid facts always pass the gate
  score: fc.float({ min: QUALITY_THRESHOLD, max: 1, noNaN: true }),
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('extractAndStore — property-based tests (sub-task 3.14)', () => {
  let db: SQLiteAdapter;
  const savedApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    stubBunFile();
    process.env.OPENROUTER_API_KEY = 'pbt-test-key';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = savedApiKey;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    await db.close();
  });

  // =========================================================================
  // P1 — Reject-pattern facts are never retained, regardless of score
  //
  // Validates: Requirements 2.7
  // =========================================================================

  it('property: pattern-matched facts are never retained regardless of score', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1–4 rejected facts paired with arbitrary scores
        fc.array(anyRejectedFactArb, { minLength: 1, maxLength: 4 }),
        async (rejectedFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          const factInputs = rejectedFacts.map(f => ({ text: f.text, category: f.category }));
          const scores = rejectedFacts.map(f => f.score);
          mockFetchForFacts(factInputs, scores);

          await extractAndStore(job, db, client);

          // No rejected fact text must appear in the retained set
          for (const rejected of rejectedFacts) {
            const wasRetained = client.retainedTexts.includes(rejected.text);
            if (wasRetained) return false;
          }
          return true;
        },
      ),
      { numRuns: 50, seed: 42 },
    );
  });

  it('property: reject-pattern facts mixed with valid facts — only valid facts are retained', async () => {
    await fc.assert(
      fc.asyncProperty(
        // At least one rejected fact and at least one valid fact in the mix
        fc.array(anyRejectedFactArb, { minLength: 1, maxLength: 3 }),
        fc.array(validFactArb, { minLength: 1, maxLength: 3 }),
        async (rejectedFacts, validFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          // Interleave rejected and valid facts to ensure ordering doesn't matter
          const allFacts: Array<{ text: string; category: string }> = [];
          const allScores: number[] = [];

          for (const f of rejectedFacts) {
            allFacts.push({ text: f.text, category: f.category });
            allScores.push(f.score);
          }
          for (const f of validFacts) {
            allFacts.push({ text: f.text, category: f.category });
            allScores.push(f.score);
          }

          mockFetchForFacts(allFacts, allScores);

          await extractAndStore(job, db, client);

          // No rejected fact must appear in the retained set
          for (const rejected of rejectedFacts) {
            if (client.retainedTexts.includes(rejected.text)) return false;
          }
          return true;
        },
      ),
      { numRuns: 50, seed: 43 },
    );
  });

  it('property: too-short facts (< 20 chars) are never retained regardless of score', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tooShortFactArb, { minLength: 1, maxLength: 4 }),
        async (shortFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          const factInputs = shortFacts.map(f => ({ text: f.text, category: f.category }));
          const scores = shortFacts.map(f => f.score);
          mockFetchForFacts(factInputs, scores);

          await extractAndStore(job, db, client);

          for (const short of shortFacts) {
            if (client.retainedTexts.includes(short.text)) return false;
          }
          return true;
        },
      ),
      { numRuns: 50, seed: 44 },
    );
  });

  it('property: too-long facts (> 500 chars) are never retained regardless of score', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tooLongFactArb, { minLength: 1, maxLength: 3 }),
        async (longFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          const factInputs = longFacts.map(f => ({ text: f.text, category: f.category }));
          const scores = longFacts.map(f => f.score);
          mockFetchForFacts(factInputs, scores);

          await extractAndStore(job, db, client);

          for (const long of longFacts) {
            if (client.retainedTexts.includes(long.text)) return false;
          }
          return true;
        },
      ),
      { numRuns: 50, seed: 45 },
    );
  });

  // =========================================================================
  // P2 — memory_count equals the number of retained IDs
  //
  // Validates: Requirements 2.9, 2.10
  // =========================================================================

  it('property: memory_count in DB equals the number of client.retain calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 0–5 valid facts with high scores so they all pass the gate
        fc.array(validFactArb, { minLength: 0, maxLength: 5 }),
        async (validFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          if (validFacts.length === 0) {
            // When the extractor returns zero facts, the scorer must return 0 scores.
            // Use an empty facts array — extraction completes cleanly with memory_count=0.
            mockFetchForFacts([], []);
          } else {
            const factInputs = validFacts.map(f => ({ text: f.text, category: f.category }));
            const scores = validFacts.map(f => f.score);
            mockFetchForFacts(factInputs, scores);
          }

          await extractAndStore(job, db, client);

          const row = await getExtractionRow(db, job.id);
          if (row === null) return false;

          const dbMemoryCount = row['memory_count'] as number;
          const actualRetainCount = client.retainedIds.length;

          return dbMemoryCount === actualRetainCount;
        },
      ),
      { numRuns: 50, seed: 46 },
    );
  });

  it('property: memory_count equals retain count after mixing valid and rejected facts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validFactArb, { minLength: 1, maxLength: 4 }),
        fc.array(anyRejectedFactArb, { minLength: 1, maxLength: 3 }),
        async (validFacts, rejectedFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          // Mix all facts together
          const allFacts: Array<{ text: string; category: string }> = [];
          const allScores: number[] = [];

          for (const f of validFacts) {
            allFacts.push({ text: f.text, category: f.category });
            allScores.push(f.score);
          }
          for (const f of rejectedFacts) {
            allFacts.push({ text: f.text, category: f.category });
            allScores.push(f.score);
          }

          mockFetchForFacts(allFacts, allScores);

          await extractAndStore(job, db, client);

          const row = await getExtractionRow(db, job.id);
          if (row === null) return false;

          return (row['memory_count'] as number) === client.retainedIds.length;
        },
      ),
      { numRuns: 50, seed: 47 },
    );
  });

  // =========================================================================
  // P3 — quality_score is always ∈ [0, 1]
  //
  // Validates: Requirements 2.10 (quality_score field)
  // =========================================================================

  it('property: quality_score written to DB is always in [0, 1]', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Valid facts with scores drawn from the full [0, 1] range
        fc.array(
          fc.record({
            text: validFactTextArb,
            category: factCategoryArb,
            // Full [0, 1] range — refinement pass may fire for low-scoring facts
            score: scoreArb,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (facts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          const factInputs = facts.map(f => ({ text: f.text, category: f.category }));
          const scores = facts.map(f => f.score);
          mockFetchForFacts(factInputs, scores);

          await extractAndStore(job, db, client);

          const row = await getExtractionRow(db, job.id);
          if (row === null) return false;

          const qualityScore = row['quality_score'] as number;
          return (
            typeof qualityScore === 'number' &&
            !Number.isNaN(qualityScore) &&
            qualityScore >= 0 &&
            qualityScore <= 1
          );
        },
      ),
      { numRuns: 50, seed: 48 },
    );
  });

  it('property: quality_score is 0 for failed extractions (missing/empty file)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Just need a job ID — file is stubbed to absent
        fc.constant(null),
        async () => {
          const job = makeJob();
          await seedJob(db, job);

          // Override the stub to simulate absent file
          jest.restoreAllMocks();
          jest.spyOn(Bun, 'file').mockReturnValue({
            exists: async () => false,
            text: async () => { throw new Error('ENOENT'); },
          } as unknown as ReturnType<typeof Bun.file>);

          const client = makeFakeClient();
          await extractAndStore(job, db, client);

          // Re-stub for future tests in this property run
          stubBunFile();

          const row = await getExtractionRow(db, job.id);
          if (row === null) return false;

          const qualityScore = row['quality_score'] as number;
          return qualityScore === 0;
        },
      ),
      // Only 10 runs — this property is deterministic but we run a few
      // iterations to confirm stability
      { numRuns: 10, seed: 49 },
    );
  });

  it('property: quality_score is in [0, 1] even when all facts are rejected by patterns', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyRejectedFactArb, { minLength: 1, maxLength: 5 }),
        async (rejectedFacts) => {
          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          const factInputs = rejectedFacts.map(f => ({ text: f.text, category: f.category }));
          const scores = rejectedFacts.map(f => f.score);
          mockFetchForFacts(factInputs, scores);

          await extractAndStore(job, db, client);

          const row = await getExtractionRow(db, job.id);
          if (row === null) return false;

          const qualityScore = row['quality_score'] as number;
          return (
            typeof qualityScore === 'number' &&
            !Number.isNaN(qualityScore) &&
            qualityScore >= 0 &&
            qualityScore <= 1
          );
        },
      ),
      { numRuns: 50, seed: 50 },
    );
  });

  // =========================================================================
  // Combined invariant — all three properties at once
  // =========================================================================

  it('property: all three invariants hold simultaneously over arbitrary fact batches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validFactArb, { minLength: 0, maxLength: 4 }),
        fc.array(anyRejectedFactArb, { minLength: 0, maxLength: 3 }),
        async (validFacts, rejectedFacts) => {
          // Require at least one fact total to exercise the pipeline
          if (validFacts.length + rejectedFacts.length === 0) return true;

          const job = makeJob();
          await seedJob(db, job);
          const client = makeFakeClient();

          const allFacts: Array<{ text: string; category: string }> = [];
          const allScores: number[] = [];

          for (const f of validFacts) {
            allFacts.push({ text: f.text, category: f.category });
            allScores.push(f.score);
          }
          for (const f of rejectedFacts) {
            allFacts.push({ text: f.text, category: f.category });
            allScores.push(f.score);
          }

          mockFetchForFacts(allFacts, allScores);

          await extractAndStore(job, db, client);

          const row = await getExtractionRow(db, job.id);
          if (row === null) return false;

          // Invariant A: no rejected fact was retained
          for (const rejected of rejectedFacts) {
            if (client.retainedTexts.includes(rejected.text)) return false;
          }

          // Invariant B: memory_count equals actual retain call count
          const dbMemoryCount = row['memory_count'] as number;
          if (dbMemoryCount !== client.retainedIds.length) return false;

          // Invariant C: quality_score ∈ [0, 1]
          const qualityScore = row['quality_score'] as number;
          if (
            typeof qualityScore !== 'number' ||
            Number.isNaN(qualityScore) ||
            qualityScore < 0 ||
            qualityScore > 1
          ) {
            return false;
          }

          return true;
        },
      ),
      { numRuns: 50, seed: 51 },
    );
  });
});
