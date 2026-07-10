/**
 * Unit Tests for `runMigrations()`
 *
 * Covers: fresh DB, already-current, partial DB, failure/rollback,
 * timeout, schema_version creation, and empty migrations directory.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 12.1
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write named migration files into a temp directory. */
function writeMigrationFiles(
  dir: string,
  migrations: Record<string, string>,
): void {
  for (const [filename, sql] of Object.entries(migrations)) {
    fs.writeFileSync(path.join(dir, filename), sql, 'utf-8');
  }
}

/** Remove a directory tree, silently ignoring errors. */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runMigrations() unit tests', () => {
  let db: SQLiteAdapter;
  let tmpDir: string;
  let originalDateNow: () => number;

  beforeEach(() => {
    db = new SQLiteAdapter(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-unit-'));
    originalDateNow = Date.now;
  });

  afterEach(async () => {
    // Always restore Date.now — even if a test throws
    Date.now = originalDateNow;
    await db.close();
    cleanupDir(tmpDir);
  });

  // ── 1. Fresh DB — applies all migration files ───────────────────────────

  it('fresh DB applies all migration files', async () => {
    writeMigrationFiles(tmpDir, {
      '001_create_users.sql':
        'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      '002_create_posts.sql':
        'CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);',
    });

    await runMigrations(db, tmpDir);

    // schema_version has one row per migration
    const countResult = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_version',
    );
    expect(countResult.rows[0]!.cnt).toBe(2);

    // MAX(version) equals the highest version number present
    const maxResult = await db.query<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_version',
    );
    expect(maxResult.rows[0]!.version).toBe(2);

    // Target tables were actually created
    const userRows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
    );
    expect(userRows.rows.length).toBe(1);

    const postRows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='posts'",
    );
    expect(postRows.rows.length).toBe(1);
  });

  // ── 2. Already-current — re-running skips all ───────────────────────────

  it('already-current DB running migrations again skips all', async () => {
    writeMigrationFiles(tmpDir, {
      '001_create_items.sql':
        'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY);',
      '002_add_label.sql':
        'ALTER TABLE items ADD COLUMN label TEXT;',
    });

    // First run — apply both
    await runMigrations(db, tmpDir);

    const afterFirst = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_version',
    );
    const countAfterFirst = afterFirst.rows[0]!.cnt;

    // Second run — should be a no-op
    await runMigrations(db, tmpDir);

    const afterSecond = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_version',
    );
    expect(afterSecond.rows[0]!.cnt).toBe(countAfterFirst);
  });

  // ── 3. Partial DB — applies only missing remainder ──────────────────────

  it('partial DB applies only the missing remainder', async () => {
    writeMigrationFiles(tmpDir, {
      '001_create_alpha.sql':
        'CREATE TABLE IF NOT EXISTS alpha (id INTEGER PRIMARY KEY);',
      '002_create_beta.sql':
        'CREATE TABLE IF NOT EXISTS beta (id INTEGER PRIMARY KEY);',
    });

    // Simulate migration 1 already having been applied
    await db.execute(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version        INTEGER PRIMARY KEY,
        applied_at     TEXT    NOT NULL,
        migration_name TEXT    NOT NULL
      )
    `);
    await db.execute(
      `INSERT INTO schema_version (version, applied_at, migration_name)
       VALUES (1, datetime('now'), '001_create_alpha.sql')`,
    );
    // Also create the table migration 1 would have created (so migration 2 can run)
    await db.execute('CREATE TABLE IF NOT EXISTS alpha (id INTEGER PRIMARY KEY);');

    // Only migration 2 should be applied
    await runMigrations(db, tmpDir);

    const countResult = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_version',
    );
    // Was 1 before, should be 2 now (only one new row inserted)
    expect(countResult.rows[0]!.cnt).toBe(2);

    const maxResult = await db.query<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_version',
    );
    expect(maxResult.rows[0]!.version).toBe(2);
  });

  // ── 4. Failure in N rolls back N but preserves N-1 ───────────────────────

  it('failure in migration 2 rolls back 2 but preserves migration 1', async () => {
    writeMigrationFiles(tmpDir, {
      '001_valid.sql':
        'CREATE TABLE IF NOT EXISTS valid_table (id INTEGER PRIMARY KEY);',
      '002_invalid.sql':
        'THIS IS NOT VALID SQL !!!',
    });

    await expect(runMigrations(db, tmpDir)).rejects.toThrow();

    // schema_version must have exactly 1 row — migration 1 succeeded
    const countResult = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_version',
    );
    expect(countResult.rows[0]!.cnt).toBe(1);

    // MAX(version) must be 1 — migration 2 was rolled back
    const maxResult = await db.query<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_version',
    );
    expect(maxResult.rows[0]!.version).toBe(1);
  });

  // ── 5. Timeout — exceeds 10 s wall-clock budget ──────────────────────────

  it('throws when 10-second wall-clock budget is exceeded', async () => {
    // Two migrations — enough to trigger the post-migration elapsed check
    writeMigrationFiles(tmpDir, {
      '001_t1.sql': 'CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);',
      '002_t2.sql': 'CREATE TABLE IF NOT EXISTS t2 (id INTEGER PRIMARY KEY);',
    });

    // Patch Date.now so that the first call returns a base time, and every
    // subsequent call returns base + 15_000ms.  The implementation records
    // startTime on the first call; subsequent calls for elapsed checks will
    // show 15 000 ms elapsed, which exceeds the 10 000 ms budget.
    const base = originalDateNow();
    let callCount = 0;
    Date.now = (): number => {
      const result = callCount === 0 ? base : base + 15_000;
      callCount++;
      return result;
    };

    await expect(runMigrations(db, tmpDir)).rejects.toThrow(
      /timeout|exceeded/i,
    );
  });

  // ── 6. schema_version created if absent (Req 5.1) ────────────────────────

  it('creates schema_version table on a fresh DB with no prior tables', async () => {
    writeMigrationFiles(tmpDir, {
      '001_simple.sql':
        'CREATE TABLE IF NOT EXISTS simple (id INTEGER PRIMARY KEY);',
    });

    // Verify schema_version does NOT exist yet
    const before = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    );
    expect(before.rows.length).toBe(0);

    await runMigrations(db, tmpDir);

    // schema_version must exist now
    const after = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    );
    expect(after.rows.length).toBe(1);
  });

  // ── 7. Empty migrations dir — no files — succeeds with MAX(version)=0 ────

  it('empty migrations directory succeeds with zero rows in schema_version', async () => {
    // tmpDir is already empty — no migration files written

    await expect(runMigrations(db, tmpDir)).resolves.toBeUndefined();

    // schema_version should exist but have no rows
    const countResult = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_version',
    );
    expect(countResult.rows[0]!.cnt).toBe(0);

    const maxResult = await db.query<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_version',
    );
    // MAX of empty set is NULL; coerce to 0 as the runner documentation states
    const maxVersion = maxResult.rows[0]?.version ?? 0;
    expect(maxVersion).toBe(0);
  });
});
