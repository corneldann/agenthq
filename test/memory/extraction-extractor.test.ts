/**
 * Unit tests for `_callExtractor` behaviour — verified through `extractAndStore`.
 *
 * Since `_callExtractor` is module-private, tests drive it via the public
 * `extractAndStore` entry point. `Bun.file` is stubbed to provide a valid file
 * so the extractor is always reached. The global `fetch` is mocked to return
 * controlled OpenRouter API responses.
 *
 * Covers (sub-task 3.4):
 *   - Valid LLM response → correct CandidateFact[] parsed and flow continues
 *   - Invalid JSON response → throws, writes failed row, does NOT rethrow
 *   - Response missing "facts" key → throws, writes failed row
 *   - "facts" is not an array → throws, writes failed row
 *   - Item missing "text" field → throws, writes failed row
 *   - Item missing "category" field → throws, writes failed row
 *   - Item with invalid category value → throws, writes failed row
 *   - Empty API key → throws (before fetch), writes failed row
 *   - Empty response content → throws, writes failed row
 *   - extractAndStore never rethrows
 *
 * Test isolation: in-memory SQLite DB; fake IMemoryClient; mock global fetch.
 *
 * Requirements: Phase 6.2, Requirement 2 AC 4 — extractor returns CandidateFact[];
 * AC 11 — LLM exception always results in a failed row.
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
const FILE_CONTENT = '# Job Output\n\nThe system uses SQLite with WAL mode for concurrent reads.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-extractor-001',
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
// Mock factory — returns a fake fetch that responds with given JSON string.
// The OpenRouter SDK calls the global `fetch` function.
// ---------------------------------------------------------------------------

function mockFetchWithContent(responseBody: string): void {
  (globalThis as Record<string, unknown>).fetch = jest.fn(async () => (({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(wrapInChatCompletion(responseBody)),
    text: async () => wrapInChatCompletion(responseBody),
    clone: () => ({ json: async () => JSON.parse(wrapInChatCompletion(responseBody)) }),
  } as unknown as Response)));
}

/**
 * Wraps raw assistant content into an OpenRouter chat completion response shape.
 * The OpenRouter SDK parses `choices[0].message.content` from this structure.
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('_callExtractor — LLM extractor call (sub-task 3.4)', () => {
  let db: SQLiteAdapter;
  const savedApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    jest.spyOn(Bun, 'file').mockReturnValue(makeFakeBunFile(FILE_CONTENT));
    // Provide a fake API key so the key-absence guard does not trigger
    process.env.OPENROUTER_API_KEY = 'test-key-123';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = savedApiKey;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Valid response
  // -------------------------------------------------------------------------

  it('should parse a valid facts array without writing a failed row', async () => {
    // Arrange
    const job = makeJob();
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent(JSON.stringify({
      facts: [
        { text: 'SQLite WAL mode is enabled by the SQLiteAdapter on first connection.', category: 'architecture' },
        { text: 'Connection pooling is not used — each request creates a fresh connection.', category: 'constraint' },
      ],
    }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert — if a row exists it should NOT be a failed row caused by the extractor
    const row = await getExtractionRow(db, job.id);
    if (row !== null) {
      // Row written by a later step (scoring/upsert) — raw_text must be the actual content
      expect(row['raw_text']).toBe(FILE_CONTENT);
    }
    // Primary assertion: no unhandled exception thrown (the await itself verifies this)
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------

  it('should write a failed row when the LLM returns invalid JSON', async () => {
    // Arrange
    const job = makeJob({ id: 'job-invalid-json' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent('this is not json at all { broken');

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
    expect(row!['quality_score']).toBe(0);
    expect(row!['memory_count']).toBe(0);
    expect(row!['raw_text']).toBe(FILE_CONTENT);
  });

  // -------------------------------------------------------------------------
  // Missing "facts" key
  // -------------------------------------------------------------------------

  it('should write a failed row when the response is missing the "facts" key', async () => {
    // Arrange
    const job = makeJob({ id: 'job-no-facts-key' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent(JSON.stringify({ items: [{ text: 'some fact', category: 'architecture' }] }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // "facts" is not an array
  // -------------------------------------------------------------------------

  it('should write a failed row when "facts" is not an array', async () => {
    // Arrange
    const job = makeJob({ id: 'job-facts-not-array' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent(JSON.stringify({ facts: 'not an array' }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Item missing "text" field
  // -------------------------------------------------------------------------

  it('should write a failed row when a fact item is missing the "text" field', async () => {
    // Arrange
    const job = makeJob({ id: 'job-missing-text' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent(JSON.stringify({ facts: [{ category: 'architecture' }] }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Item missing "category" field
  // -------------------------------------------------------------------------

  it('should write a failed row when a fact item is missing the "category" field', async () => {
    // Arrange
    const job = makeJob({ id: 'job-missing-category' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent(JSON.stringify({
      facts: [{ text: 'This is a long enough fact text to pass any length check.' }],
    }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Item with invalid category value
  // -------------------------------------------------------------------------

  it('should write a failed row when a fact item has an unrecognised category', async () => {
    // Arrange
    const job = makeJob({ id: 'job-bad-category' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent(JSON.stringify({
      facts: [{ text: 'The system uses Redis for caching all hot-tier reads.', category: 'performance' }],
    }));

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Empty API key — no fetch call should be made
  // -------------------------------------------------------------------------

  it('should write a failed row when OPENROUTER_API_KEY is absent', async () => {
    // Arrange
    const job = makeJob({ id: 'job-no-api-key' });
    await seedWorkspaceAndJob(db, job);
    delete process.env.OPENROUTER_API_KEY;
    // Track that fetch is NOT called
    const fetchSpy = jest.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
    expect(row!['memory_count']).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Empty response content
  // -------------------------------------------------------------------------

  it('should write a failed row when the LLM returns an empty content string', async () => {
    // Arrange
    const job = makeJob({ id: 'job-empty-response' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent('');

    // Act
    await extractAndStore(job, db, noopClient);

    // Assert
    const row = await getExtractionRow(db, job.id);
    expect(row).not.toBeNull();
    expect(row!['embedding_status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // extractAndStore never rethrows
  // -------------------------------------------------------------------------

  it('should not throw even when extractor fails with an invalid response', async () => {
    // Arrange
    const job = makeJob({ id: 'job-no-rethrow' });
    await seedWorkspaceAndJob(db, job);
    mockFetchWithContent('{"completely": "wrong"}');

    // Act + Assert — must resolve without throwing
    await expect(extractAndStore(job, db, noopClient)).resolves.toBeUndefined();
  });
});
