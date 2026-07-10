/**
 * Unit tests for SQLiteAdapter.
 *
 * Most tests use an in-memory database (`:memory:`) so no files are created
 * on disk and each test gets a clean state via beforeEach.
 * The WAL test uses a temporary file-backed database because SQLite does not
 * support WAL journal mode on in-memory databases (it always reports "memory").
 *
 * Requirements: 12.1
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple test table in the given adapter. */
async function createTestTable(adapter: SQLiteAdapter): Promise<void> {
  await adapter.execute(
    'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0)'
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    adapter = new SQLiteAdapter(':memory:');
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      // Already closed in the test — that's fine.
    }
  });

  // -------------------------------------------------------------------------
  // Insert + query round-trip
  // -------------------------------------------------------------------------

  it('should insert a row and query it back', async () => {
    await createTestTable(adapter);

    const exec = await adapter.execute(
      'INSERT INTO items (name, value) VALUES (?, ?)',
      ['alpha', 42]
    );

    expect(exec.rowsAffected).toBe(1);
    expect(exec.lastInsertRowid).toBeDefined();

    const result = await adapter.query<{ id: number; name: string; value: number }>(
      'SELECT id, name, value FROM items WHERE name = ?',
      ['alpha']
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ name: 'alpha', value: 42 });
  });

  it('should return zero rows for a query that matches nothing', async () => {
    await createTestTable(adapter);

    const result = await adapter.query('SELECT * FROM items WHERE name = ?', ['ghost']);

    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(0);
  });

  it('should return multiple rows when multiple rows match', async () => {
    await createTestTable(adapter);

    await adapter.execute('INSERT INTO items (name, value) VALUES (?, ?)', ['x', 1]);
    await adapter.execute('INSERT INTO items (name, value) VALUES (?, ?)', ['x', 2]);

    const result = await adapter.query<{ name: string; value: number }>(
      'SELECT name, value FROM items WHERE name = ? ORDER BY value',
      ['x']
    );

    expect(result.rowCount).toBe(2);
    expect(result.rows[0]?.value).toBe(1);
    expect(result.rows[1]?.value).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Transaction — commit
  // -------------------------------------------------------------------------

  it('should commit a transaction and make rows visible afterwards', async () => {
    await createTestTable(adapter);

    await adapter.transaction(async (tx) => {
      await tx.execute('INSERT INTO items (name, value) VALUES (?, ?)', ['committed', 99]);
    });

    const result = await adapter.query<{ name: string }>(
      'SELECT name FROM items WHERE name = ?',
      ['committed']
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.name).toBe('committed');
  });

  // -------------------------------------------------------------------------
  // Transaction — rollback on error
  // -------------------------------------------------------------------------

  it('should rollback a transaction when the callback throws', async () => {
    await createTestTable(adapter);

    // Insert a row outside the transaction as a baseline.
    await adapter.execute('INSERT INTO items (name, value) VALUES (?, ?)', ['baseline', 1]);

    await expect(
      adapter.transaction(async (tx) => {
        await tx.execute('INSERT INTO items (name, value) VALUES (?, ?)', ['will-be-rolled-back', 2]);
        throw new Error('intentional failure');
      })
    ).rejects.toThrow('intentional failure');

    // The row inserted inside the failed transaction must not be present.
    const result = await adapter.query<{ name: string }>(
      'SELECT name FROM items',
      []
    );

    const names = result.rows.map((r) => r.name);
    expect(names).toContain('baseline');
    expect(names).not.toContain('will-be-rolled-back');
  });

  it('should re-throw the original error after rollback', async () => {
    await createTestTable(adapter);

    const sentinel = new Error('sentinel error');
    let caught: unknown;

    try {
      await adapter.transaction(async () => {
        throw sentinel;
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(sentinel);
  });

  // -------------------------------------------------------------------------
  // close() then query throws
  // -------------------------------------------------------------------------

  it('should throw when query() is called after close()', async () => {
    await createTestTable(adapter);
    await adapter.close();

    await expect(
      adapter.query('SELECT 1')
    ).rejects.toThrow();
  });

  it('should throw when execute() is called after close()', async () => {
    await createTestTable(adapter);
    await adapter.close();

    await expect(
      adapter.execute('INSERT INTO items (name, value) VALUES (?, ?)', ['x', 0])
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // WAL journal mode
  // -------------------------------------------------------------------------

  it('should set WAL journal mode after enableWal()', async () => {
    // SQLite does not support WAL on in-memory databases — PRAGMA journal_mode
    // always returns "memory" for `:memory:`.  Use a temporary file-backed DB
    // so the pragma actually takes effect and we can verify it.
    const tmpPath = join(import.meta.dir, `wal-test-${Date.now()}.db`);
    const walAdapter = new SQLiteAdapter(tmpPath);

    try {
      walAdapter.enableWal();

      const result = await walAdapter.query<{ journal_mode: string }>(
        'PRAGMA journal_mode'
      );

      expect(result.rows[0]?.journal_mode).toBe('wal');
    } finally {
      await walAdapter.close();
      // Clean up the temporary database files (main + WAL shm/wal sidecar files).
      for (const suffix of ['', '-shm', '-wal']) {
        try { rmSync(tmpPath + suffix); } catch { /* file may not exist */ }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Foreign keys ON
  // -------------------------------------------------------------------------

  it('should enforce foreign key constraints (foreign_keys = ON)', async () => {
    // Create a parent and a referencing child table.
    await adapter.execute(
      'CREATE TABLE parents (id INTEGER PRIMARY KEY)'
    );
    await adapter.execute(
      'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id))'
    );

    // Insert with a valid parent — should succeed.
    await adapter.execute('INSERT INTO parents (id) VALUES (?)', [1]);
    const exec = await adapter.execute(
      'INSERT INTO children (id, parent_id) VALUES (?, ?)',
      [10, 1]
    );
    expect(exec.rowsAffected).toBe(1);

    // Insert with a missing parent — must throw.
    await expect(
      adapter.execute(
        'INSERT INTO children (id, parent_id) VALUES (?, ?)',
        [20, 999]
      )
    ).rejects.toThrow();
  });
});
