/**
 * Migration Test: 004_memory_extraction.sql
 *
 * Applies all migrations up to and including 004 to an in-memory SQLite DB,
 * then asserts that:
 *   - The `memory_extraction` table exists with all expected columns
 *   - Both partial indexes (`idx_memext_workspace`, `idx_memext_pending`) exist
 *
 * Uses PRAGMA table_info and PRAGMA index_list for introspection — the
 * canonical SQLite way to verify schema shape without relying on implementation
 * internals.
 *
 * Requirements: Phase 6.2, sub-task 1.7
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../migrations');

/** All columns expected on the `memory_extraction` table, in any order. */
const EXPECTED_COLUMNS = [
  'id',
  'job_id',
  'workspace_id',
  'extracted_at',
  'raw_text',
  'memory_count',
  'quality_score',
  'embedding_status',
  'embed_attempts',
  'tier',
  'last_modified',
  'deleted_at',
] as const;

/** Both indexes introduced by migration 004. */
const EXPECTED_INDEXES = ['idx_memext_workspace', 'idx_memext_pending'] as const;

// ---------------------------------------------------------------------------
// PRAGMA row shapes
// ---------------------------------------------------------------------------

type PragmaTableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type PragmaIndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Migration 004 — memory_extraction schema', () => {
  let db: SQLiteAdapter;

  beforeEach(() => {
    db = new SQLiteAdapter(':memory:');
  });

  afterEach(async () => {
    await db.close();
  });

  // ── Shared arrange + act ─────────────────────────────────────────────────
  //
  // All three test cases below depend on a DB that has had migrations 001–004
  // applied. We run migrations once per test (each test gets a fresh :memory:
  // DB from beforeEach), which keeps the tests independent.

  it('should create the memory_extraction table after running migrations', async () => {
    // Arrange: fresh in-memory DB (from beforeEach)

    // Act: apply all migrations (001 through 004)
    await runMigrations(db, MIGRATIONS_DIR);

    // Assert: table exists in sqlite_master
    const result = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_extraction'",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.name).toBe('memory_extraction');
  });

  it('should have all expected columns on the memory_extraction table', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    // Act: introspect column list
    const result = await db.query<PragmaTableInfoRow>(
      "PRAGMA table_info('memory_extraction')",
    );
    const columnNames = result.rows.map(r => r.name);

    // Assert: every expected column is present
    for (const col of EXPECTED_COLUMNS) {
      expect(columnNames).toContain(col);
    }

    // Assert: no unexpected extra columns (exact count match)
    expect(columnNames.length).toBe(EXPECTED_COLUMNS.length);
  });

  it('should have the correct NOT NULL and DEFAULT constraints on key columns', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    // Act
    const result = await db.query<PragmaTableInfoRow>(
      "PRAGMA table_info('memory_extraction')",
    );
    const byName = Object.fromEntries(result.rows.map(r => [r.name, r]));

    // Assert: NOT NULL columns
    const notNullColumns = [
      'job_id',
      'workspace_id',
      'extracted_at',
      'raw_text',
      'memory_count',
      'quality_score',
      'embedding_status',
      'embed_attempts',
      'tier',
      'last_modified',
    ] as const;

    for (const col of notNullColumns) {
      expect(byName[col]!.notnull).toBe(1);
    }

    // Assert: deleted_at is nullable (NOT NULL = 0)
    expect(byName['deleted_at']!.notnull).toBe(0);

    // Assert: DEFAULT values
    expect(byName['memory_count']!.dflt_value).toBe('0');
    expect(byName['quality_score']!.dflt_value).toBe('0.0');
    expect(byName['embedding_status']!.dflt_value).toBe("'pending'");
    expect(byName['embed_attempts']!.dflt_value).toBe('0');
    expect(byName['tier']!.dflt_value).toBe("'cold'");
  });

  it('should create both partial indexes on the memory_extraction table', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    // Act: introspect index list
    const result = await db.query<PragmaIndexListRow>(
      "PRAGMA index_list('memory_extraction')",
    );
    const indexNames = result.rows.map(r => r.name);

    // Assert: both indexes exist
    for (const idx of EXPECTED_INDEXES) {
      expect(indexNames).toContain(idx);
    }
  });

  it('should mark both indexes as partial (WHERE clause) indexes', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    // Act
    const result = await db.query<PragmaIndexListRow>(
      "PRAGMA index_list('memory_extraction')",
    );
    const indexByName = Object.fromEntries(result.rows.map(r => [r.name, r]));

    // Assert: partial = 1 means the index has a WHERE clause
    expect(indexByName['idx_memext_workspace']!.partial).toBe(1);
    expect(indexByName['idx_memext_pending']!.partial).toBe(1);
  });

  it('should allow inserting a valid row after migration 004', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    // Insert a prerequisite workspace and job (FK chain: workspace ← job ← memory_extraction)
    await db.execute(
      `INSERT INTO workspaces (id, output_dir, sessions_dir, created_at)
       VALUES ('ws-1', '/tmp/out', '/tmp/sess', '2024-01-01T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO jobs
         (id, workspace_id, name, job_chain, session_chain_id, timestamp, type,
          agent, status, lines, last_line, has_log, log_error, md_file, log_file,
          agent_done, size_bytes, last_modified)
       VALUES
         ('job-1', 'ws-1', 'Test Job', '', '', '2024-01-01T00:00:00.000Z', 'test',
          'kiro', 'done', 0, '', 0, 0, '', '', '', 0, 0)`,
    );

    // Act: insert into memory_extraction using all default-eligible columns
    await db.execute(
      `INSERT INTO memory_extraction
         (job_id, workspace_id, extracted_at, raw_text, last_modified)
       VALUES
         ('job-1', 'ws-1', '2024-01-01T00:00:00.000Z', 'some extracted text', 1704067200000)`,
    );

    // Assert: row is present with correct defaults
    const result = await db.query<{
      job_id: string;
      embedding_status: string;
      tier: string;
      memory_count: number;
      quality_score: number;
      embed_attempts: number;
    }>(
      `SELECT job_id, embedding_status, tier, memory_count, quality_score, embed_attempts
       FROM memory_extraction WHERE job_id = 'job-1'`,
    );
    expect(result.rows.length).toBe(1);
    const row = result.rows[0]!;
    expect(row.job_id).toBe('job-1');
    expect(row.embedding_status).toBe('pending');
    expect(row.tier).toBe('cold');
    expect(row.memory_count).toBe(0);
    expect(row.quality_score).toBe(0.0);
    expect(row.embed_attempts).toBe(0);
  });

  it('should enforce the embedding_status CHECK constraint', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    await db.execute(
      `INSERT INTO workspaces (id, output_dir, sessions_dir, created_at)
       VALUES ('ws-2', '/tmp/out', '/tmp/sess', '2024-01-01T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO jobs
         (id, workspace_id, name, job_chain, session_chain_id, timestamp, type,
          agent, status, lines, last_line, has_log, log_error, md_file, log_file,
          agent_done, size_bytes, last_modified)
       VALUES
         ('job-2', 'ws-2', 'Test Job', '', '', '2024-01-01T00:00:00.000Z', 'test',
          'kiro', 'done', 0, '', 0, 0, '', '', '', 0, 0)`,
    );

    // Act + Assert: invalid embedding_status must throw
    expect(
      db.execute(
        `INSERT INTO memory_extraction
           (job_id, workspace_id, extracted_at, raw_text, embedding_status, last_modified)
         VALUES
           ('job-2', 'ws-2', '2024-01-01T00:00:00.000Z', 'text', 'invalid_status', 0)`,
      ),
    ).rejects.toThrow();
  });

  it('should enforce the tier CHECK constraint', async () => {
    // Arrange
    await runMigrations(db, MIGRATIONS_DIR);

    await db.execute(
      `INSERT INTO workspaces (id, output_dir, sessions_dir, created_at)
       VALUES ('ws-3', '/tmp/out', '/tmp/sess', '2024-01-01T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO jobs
         (id, workspace_id, name, job_chain, session_chain_id, timestamp, type,
          agent, status, lines, last_line, has_log, log_error, md_file, log_file,
          agent_done, size_bytes, last_modified)
       VALUES
         ('job-3', 'ws-3', 'Test Job', '', '', '2024-01-01T00:00:00.000Z', 'test',
          'kiro', 'done', 0, '', 0, 0, '', '', '', 0, 0)`,
    );

    // Act + Assert: invalid tier must throw
    expect(
      db.execute(
        `INSERT INTO memory_extraction
           (job_id, workspace_id, extracted_at, raw_text, tier, last_modified)
         VALUES
           ('job-3', 'ws-3', '2024-01-01T00:00:00.000Z', 'text', 'warm', 0)`,
      ),
    ).rejects.toThrow();
  });
});
