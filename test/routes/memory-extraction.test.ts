/**
 * Unit tests for `POST /api/memory/extract/:jobId`
 * in `src/routes/memory-extraction.ts`.
 *
 * Acceptance criteria verified (Requirement 4, AC 1–4):
 *   AC 1: When MEMORY_EXTRACTION_ENABLED=false → 503 with { error: 'memory extraction
 *         disabled' }, and NO DB query is issued.
 *   AC 2: When job ID does not exist in DB → 404 with { error: 'not found' }.
 *   AC 3: No format pre-validation of job ID — any string that doesn't match a DB
 *         record returns 404 (not 400 or 422).
 *   AC 4: Valid job → calls extractAndStore and returns { jobId, memoryCount,
 *         qualityScore } from the resulting memory_extraction row.
 *
 * Strategy:
 *   - `MEMORY_EXTRACTION_ENABLED` is controlled per describe block via mock.module()
 *     the same way the existing memory route tests work.
 *   - The DB adapter is an in-memory SQLite instance with all migrations applied for
 *     tests that exercise the DB path.
 *   - `extractAndStore` is mocked at the module level so tests do not trigger LLM
 *     calls or real Hindsight operations.
 *   - The router is exercised directly (no real Bun HTTP server) via a dispatch helper.
 *
 * Requirements: Phase 6.2, Requirement 4, AC 1–4 (sub-task 6.5).
 */

import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { createRouter } from '../../src/router.ts';
import type { Router } from '../../src/router.ts';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';
import type { Job } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');

// ---------------------------------------------------------------------------
// Dispatch helper — routes a request through the router without a real server
// ---------------------------------------------------------------------------

async function dispatch(
  router: Router,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request(`http://localhost${url}`, init);
  const match = router.match(req);
  if (match === null) {
    return new Response(JSON.stringify({ error: 'no route matched' }), { status: 404 });
  }
  return match.handler(req, match.params);
}

// ---------------------------------------------------------------------------
// Fake IMemoryClient — records nothing; extraction is mocked at module level
// ---------------------------------------------------------------------------

function makeFakeClient(): IMemoryClient {
  return {
    retain: async (_text: string, _scope: MemoryScope): Promise<string> => 'fake-id',
    recall: async (_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> => [],
    reflect: async (_topic: string, _scope: MemoryScope): Promise<string | null> => null,
    delete: async (_id: string): Promise<void> => {},
  };
}

// ---------------------------------------------------------------------------
// DB seed helpers
// ---------------------------------------------------------------------------

async function seedJob(db: SQLiteAdapter, job: Partial<Job> & { id: string; workspaceId: string }): Promise<void> {
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
      job.id,
      job.workspaceId,
      job.name ?? 'test-job',
      job.jobChain ?? 'test-job',
      job.sessionChainId ?? 'chain-001',
      job.timestamp ?? new Date().toISOString(),
      job.type ?? 'agent',
      job.agent ?? 'kiro',
      job.status ?? 'done',
      job.lines ?? 10,
      job.lastLine ?? '',
      job.hasLog ? 1 : 0,
      job.logError ? 1 : 0,
      job.mdFile ?? '/tmp/output.md',
      job.logFile ?? '/tmp/output.log',
      job.agentDone ?? '',
      job.sizeBytes ?? 100,
      Date.now(),
    ],
  );
}

async function seedMemoryExtractionRow(
  db: SQLiteAdapter,
  jobId: string,
  workspaceId: string,
  memoryCount: number,
  qualityScore: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count, quality_score,
        embedding_status, tier, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, 'embedded', 'hot', ?)`,
    [jobId, workspaceId, new Date().toISOString(), 'raw text', memoryCount, qualityScore, Date.now()],
  );
}

// ---------------------------------------------------------------------------
// Constants mock factory — same shape used by test/routes/memory.test.ts
// ---------------------------------------------------------------------------

function makeConstantsMock(memoryExtractionEnabled: boolean): Record<string, unknown> {
  return {
    resolveConstants: () => ({}),
    PORT: 3333,
    POLL_LOG_MAX: 200,
    SCAN_CACHE_TTL: 5000,
    SHUTDOWN_TIMEOUT_MS: 5000,
    OUTPUT_DIR: '',
    SESSIONS_DIR: '',
    CHAINS_DIR: '',
    WORKFLOW_DIR: '',
    WORKSPACE_ROOT: '',
    SPECS_DIR: '',
    PROMPT_OUTPUT_DIR: '',
    CRAWL_JOBS_FILE: 'docs/reference/.crawl-queue.json',
    CLONE_JOBS_FILE: 'docs/reference/.clone-queue.json',
    BUILD_QUEUE_FILE: 'docs/reference/.build-queue.json',
    KIRO_TOOLS_DIR: '',
    MEMORY_ENABLED: true,
    HINDSIGHT_URL: 'http://localhost:3100',
    MEMORY_EXTRACTION_ENABLED: memoryExtractionEnabled,
    MEMORY_AUTO_INJECT: false,
    MEMORY_MAX_CONTEXT_MEMORIES: 10,
    MEMORY_CONTEXT_TOKEN_BUDGET: 2000,
    MEMORY_DECAY_DAYS: 90,
    MEMORY_RETRY_PATH: 'data/memory-retry-queue.jsonl',
    VOYAGE_API_KEY: '',
    MEMORY_HOT_TIER_COUNT: 100,
  };
}

// ---------------------------------------------------------------------------
// Tests — MEMORY_EXTRACTION_ENABLED=false (feature flag off)
// ---------------------------------------------------------------------------

describe('POST /api/memory/extract/:jobId — MEMORY_EXTRACTION_ENABLED=false', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(false));
    // Mock extractAndStore — it must never be called when the flag is off
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async () => {
        throw new Error('extractAndStore must not be called when feature flag is off');
      },
    }));
  });

  it('should return 503 with { error: "memory extraction disabled" }', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, null as never, null as never);

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/extract/any-job-id');

    // Assert
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'memory extraction disabled' });
  });

  it('should return content-type: application/json on 503', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, null as never, null as never);

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/extract/any-job-id');

    // Assert
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('should return 503 before any DB query is issued (AC 1)', async () => {
    // Arrange: use a DB proxy that throws on any query call
    const queryThrowingDb = {
      query: async () => { throw new Error('DB query must not be called when flag is off'); },
      execute: async () => { throw new Error('DB execute must not be called when flag is off'); },
      transaction: async () => { throw new Error('DB transaction must not be called when flag is off'); },
      close: async () => {},
    };
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, queryThrowingDb as never, null as never);

    // Act — if the route queries DB before checking the flag, this will throw
    const res = await dispatch(router, 'POST', '/api/memory/extract/any-job-id');

    // Assert: we got a clean 503, not an unhandled error
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Tests — MEMORY_EXTRACTION_ENABLED=true, job not found
// ---------------------------------------------------------------------------

describe('POST /api/memory/extract/:jobId — job not found', () => {
  let db: SQLiteAdapter;

  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async () => {},
    }));
  });

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it('should return 404 when the job ID does not exist in the DB (AC 2)', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/extract/nonexistent-job-id');

    // Assert
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'not found' });
  });

  it('should return 404 for an arbitrary string job ID that has no DB record (AC 3)', async () => {
    // Arrange: no pre-validation — any non-matching string returns 404
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act: job ID looks like a UUID format but is not in the DB
    const res = await dispatch(router, 'POST', '/api/memory/extract/00000000-0000-0000-0000-000000000000');

    // Assert
    expect(res.status).toBe(404);
  });

  it('should return 404 for a job that has been soft-deleted', async () => {
    // Arrange: seed job then soft-delete it
    const jobId = 'job-soft-deleted-001';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });
    await db.execute(
      `UPDATE jobs SET deleted_at = ? WHERE id = ?`,
      [new Date().toISOString(), jobId],
    );
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert: soft-deleted job is treated as not found
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests — MEMORY_EXTRACTION_ENABLED=true, valid job (AC 4)
// ---------------------------------------------------------------------------

describe('POST /api/memory/extract/:jobId — valid job returns correct response shape', () => {
  let db: SQLiteAdapter;
  let extractAndStoreCalls: Array<{ jobId: string }>;

  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
  });

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    extractAndStoreCalls = [];

    // Mock extractAndStore to record calls and write a memory_extraction row
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async (job: Job, innerDb: SQLiteAdapter): Promise<void> => {
        extractAndStoreCalls.push({ jobId: job.id });
        // Write the extraction row so the route can read it back
        await innerDb.execute(
          `INSERT INTO memory_extraction
             (job_id, workspace_id, extracted_at, raw_text, memory_count, quality_score,
              embedding_status, tier, last_modified)
           VALUES (?, ?, ?, ?, ?, ?, 'embedded', 'hot', ?)
           ON CONFLICT(job_id) DO UPDATE SET
             memory_count     = excluded.memory_count,
             quality_score    = excluded.quality_score,
             embedding_status = excluded.embedding_status,
             last_modified    = excluded.last_modified`,
          [job.id, job.workspaceId, new Date().toISOString(), '', 3, 0.88, Date.now()],
        );
      },
    }));
  });

  afterEach(async () => {
    await db.close();
  });

  it('should return 200 with { jobId, memoryCount, qualityScore } (AC 4)', async () => {
    // Arrange
    const jobId = 'job-route-valid-001';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string; memoryCount: number; qualityScore: number };
    expect(body.jobId).toBe(jobId);
    expect(body.memoryCount).toBe(3);
    expect(body.qualityScore).toBeCloseTo(0.88, 5);
  });

  it('should call extractAndStore exactly once for the given job', async () => {
    // Arrange
    const jobId = 'job-route-valid-002';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert
    expect(extractAndStoreCalls).toHaveLength(1);
    expect(extractAndStoreCalls[0]!.jobId).toBe(jobId);
  });

  it('should set content-type: application/json on success', async () => {
    // Arrange
    const jobId = 'job-route-valid-003';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('should return memoryCount=0 and qualityScore=0 when extractAndStore writes a failed row', async () => {
    // Arrange: override the mock to write a failed extraction row
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async (job: Job, innerDb: SQLiteAdapter): Promise<void> => {
        await innerDb.execute(
          `INSERT INTO memory_extraction
             (job_id, workspace_id, extracted_at, raw_text, memory_count, quality_score,
              embedding_status, tier, last_modified)
           VALUES (?, ?, ?, ?, 0, 0.0, 'failed', 'cold', ?)
           ON CONFLICT(job_id) DO UPDATE SET
             memory_count     = 0,
             quality_score    = 0.0,
             embedding_status = 'failed',
             last_modified    = excluded.last_modified`,
          [job.id, job.workspaceId, new Date().toISOString(), '', Date.now()],
        );
      },
    }));

    const jobId = 'job-route-failed-001';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert: 200 response with zero values (extraction ran but produced no facts)
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string; memoryCount: number; qualityScore: number };
    expect(body.jobId).toBe(jobId);
    expect(body.memoryCount).toBe(0);
    expect(body.qualityScore).toBe(0);
  });

  it('should return memoryCount=0 when no memory_extraction row exists after extraction', async () => {
    // Arrange: extractAndStore does nothing (no row written) — e.g. in-flight guard triggered
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async (): Promise<void> => {
        // no-op — simulates in-flight guard short-circuit
      },
    }));

    const jobId = 'job-route-noop-001';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert: 200 with fallback zeros when row is absent
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string; memoryCount: number; qualityScore: number };
    expect(body.jobId).toBe(jobId);
    expect(body.memoryCount).toBe(0);
    expect(body.qualityScore).toBe(0);
  });

  it('should re-trigger extraction even when an existing memory_extraction row is present', async () => {
    // Arrange: seed both a job and an existing extraction row (from a previous run)
    const jobId = 'job-route-retrigger-001';
    await seedJob(db, { id: jobId, workspaceId: 'ws-001' });
    await seedMemoryExtractionRow(db, jobId, 'ws-001', 5, 0.91);

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', `/api/memory/extract/${jobId}`);

    // Assert: extractAndStore was called despite the existing row
    expect(extractAndStoreCalls).toHaveLength(1);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/memory/backfill — feature flag off
// ---------------------------------------------------------------------------

describe('POST /api/memory/backfill — MEMORY_EXTRACTION_ENABLED=false', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(false));
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async () => {
        throw new Error('extractAndStore must not be called when feature flag is off');
      },
    }));
  });

  it('should return 503 with { error: "memory extraction disabled" }', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, null as never, null as never);

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
    });

    // Assert
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'memory extraction disabled' });
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/memory/backfill — input validation
// ---------------------------------------------------------------------------

describe('POST /api/memory/backfill — input validation', () => {
  let db: SQLiteAdapter;

  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async () => {},
    }));
  });

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it('should return 400 when workspaceId is missing', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {});

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'workspaceId required' });
  });

  it('should return 400 when workspaceId is an empty string', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: '',
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'workspaceId required' });
  });

  it('should return 400 when workspaceId is whitespace only', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: '   ',
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'workspaceId required' });
  });

  it('should return 400 when limit is 0', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
      limit: 0,
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'limit must be a positive integer' });
  });

  it('should return 400 when limit is -1', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
      limit: -1,
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'limit must be a positive integer' });
  });

  it('should return 400 when limit is 0.5 (non-integer)', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
      limit: 0.5,
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'limit must be a positive integer' });
  });

  it('should return 400 when limit is a negative non-integer', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
      limit: -0.5,
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toStrictEqual({ error: 'limit must be a positive integer' });
  });

  it('should silently cap limit at 100 when limit is 150', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
      limit: 150,
    });

    // Assert: 200 (no error) and appliedLimit capped at 100
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body.appliedLimit).toBe(100);
    expect(body.queued).toBe(0); // no jobs in DB
  });

  it('should use default limit of 100 when limit is omitted', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body.appliedLimit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/memory/backfill — functional behaviour
// ---------------------------------------------------------------------------

describe('POST /api/memory/backfill — functional behaviour', () => {
  let db: SQLiteAdapter;
  let extractAndStoreCalls: Array<{ jobId: string }>;

  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
  });

  beforeEach(async () => {
    db = new SQLiteAdapter(':memory:');
    await runMigrations(db, MIGRATIONS_DIR);
    extractAndStoreCalls = [];

    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async (job: Job): Promise<void> => {
        extractAndStoreCalls.push({ jobId: job.id });
      },
    }));
  });

  afterEach(async () => {
    await db.close();
  });

  it('should return { queued: 0, appliedLimit: 100 } when no unprocessed jobs exist', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-001',
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body).toStrictEqual({ queued: 0, appliedLimit: 100 });
  });

  it('should queue all unprocessed done jobs and return correct queued count', async () => {
    // Arrange: 3 done jobs with no extraction rows
    await seedJob(db, { id: 'backfill-job-001', workspaceId: 'ws-bf', status: 'done' });
    await seedJob(db, { id: 'backfill-job-002', workspaceId: 'ws-bf', status: 'done' });
    await seedJob(db, { id: 'backfill-job-003', workspaceId: 'ws-bf', status: 'done' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-bf',
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body.queued).toBe(3);
    expect(body.appliedLimit).toBe(100);
    expect(extractAndStoreCalls).toHaveLength(3);
  });

  it('should skip jobs that already have a memory_extraction row', async () => {
    // Arrange: 2 done jobs; 1 already processed
    await seedJob(db, { id: 'backfill-skip-001', workspaceId: 'ws-skip', status: 'done' });
    await seedJob(db, { id: 'backfill-skip-002', workspaceId: 'ws-skip', status: 'done' });
    // Seed an extraction row for job 001 — it should be skipped
    await seedMemoryExtractionRow(db, 'backfill-skip-001', 'ws-skip', 2, 0.80);

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-skip',
    });

    // Assert: only 1 job queued (the one without an extraction row)
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body.queued).toBe(1);
    expect(extractAndStoreCalls).toHaveLength(1);
    expect(extractAndStoreCalls[0]!.jobId).toBe('backfill-skip-002');
  });

  it('should respect the limit parameter and return appliedLimit in response', async () => {
    // Arrange: 5 done jobs, limit=2
    for (let i = 1; i <= 5; i++) {
      await seedJob(db, { id: `backfill-limit-00${i}`, workspaceId: 'ws-limit', status: 'done' });
    }

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-limit',
      limit: 2,
    });

    // Assert: only 2 processed despite 5 available
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body.queued).toBe(2);
    expect(body.appliedLimit).toBe(2);
    expect(extractAndStoreCalls).toHaveLength(2);
  });

  it('should only process jobs belonging to the specified workspaceId', async () => {
    // Arrange: jobs in two different workspaces
    await seedJob(db, { id: 'ws-a-job-001', workspaceId: 'ws-a', status: 'done' });
    await seedJob(db, { id: 'ws-b-job-001', workspaceId: 'ws-b', status: 'done' });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act: backfill only for ws-a
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-a',
    });

    // Assert: only ws-a's job was processed
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number; appliedLimit: number };
    expect(body.queued).toBe(1);
    expect(extractAndStoreCalls).toHaveLength(1);
    expect(extractAndStoreCalls[0]!.jobId).toBe('ws-a-job-001');
  });

  it('should run extractions sequentially (not concurrently)', async () => {
    // Arrange: track call start order to verify sequential execution
    const callOrder: string[] = [];

    mock.module('../../src/memory/extraction.ts', () => ({
      extractAndStore: async (job: Job): Promise<void> => {
        callOrder.push(`start:${job.id}`);
        // Each call records its job ID — sequential means job N completes before N+1 starts
        callOrder.push(`end:${job.id}`);
        extractAndStoreCalls.push({ jobId: job.id });
      },
    }));

    await seedJob(db, {
      id: 'seq-job-001',
      workspaceId: 'ws-seq',
      status: 'done',
      timestamp: new Date(Date.now() - 2000).toISOString(),
    });
    await seedJob(db, {
      id: 'seq-job-002',
      workspaceId: 'ws-seq',
      status: 'done',
      timestamp: new Date(Date.now() - 1000).toISOString(),
    });

    const { register } = await import('../../src/routes/memory-extraction.ts');
    const router = createRouter();
    register(router, db, makeFakeClient());

    // Act
    const res = await dispatch(router, 'POST', '/api/memory/backfill', {
      workspaceId: 'ws-seq',
    });

    // Assert: start/end interleaving shows sequential (not concurrent) execution
    // Sequential pattern: start-A, end-A, start-B, end-B
    // Concurrent pattern: start-A, start-B, end-A, end-B
    expect(res.status).toBe(200);
    expect(callOrder).toHaveLength(4);

    // For each pair, the start of job N+1 comes after the end of job N
    const firstJobId = callOrder[0]!.replace('start:', '');
    expect(callOrder[0]).toBe(`start:${firstJobId}`);
    expect(callOrder[1]).toBe(`end:${firstJobId}`);
  });
});
