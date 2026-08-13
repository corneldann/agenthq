/**
 * Database migration runner.
 *
 * Discovers `.sql` files matching `/^\d+_.*\.sql$/` in the given directory,
 * sorts them numerically by version prefix, and applies each one that has not
 * yet been recorded in the `schema_version` table.
 *
 * Each migration runs inside its own transaction; the `schema_version` row is
 * inserted in the same transaction so the two are always atomic.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 10.3
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DbAdapter } from './adapter.js';

/** Total wall-clock budget for all pending migrations (ms). */
const MIGRATION_TIMEOUT_MS = 10_000;

/**
 * Split a SQL migration file into individual executable statements.
 *
 * `bun:sqlite`'s `prepare()` only compiles the *first* statement in a
 * multi-statement string.  Migration files commonly start with `PRAGMA`
 * directives followed by `CREATE TABLE` blocks — without splitting, only the
 * PRAGMA runs and all DDL is silently skipped.
 *
 * Strategy:
 * 1. Strip line comments (`-- …`) so semicolons inside comments don't split.
 * 2. Split on `;` to get raw token groups.
 * 3. Trim whitespace and skip empty strings.
 *
 * PRAGMA statements are kept in the output — the SQLite engine accepts them
 * inside transactions (they re-apply per-connection settings that the adapter
 * constructor already sets, so re-executing them is harmless).
 *
 * @param sql Raw content of a `.sql` migration file
 * @returns Array of non-empty SQL statements, each ready for `execute()`
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))   // strip line comments
    .join('\n')
    .split(';')                                // split on statement terminator
    .map(s => s.trim())
    .filter(s => s.length > 0);               // drop empty segments
}

/**
 * Ensure `schema_version` exists, discover pending `.sql` migration files, and
 * apply each one in version order within its own transaction.
 *
 * @param db           Database adapter (SQLite or PostgreSQL)
 * @param migrationsDir Absolute or relative path to the migrations folder
 * @throws If any migration fails, if rollback fails, or if the 10-second
 *         wall-clock budget is exceeded
 */
export async function runMigrations(
  db: DbAdapter,
  migrationsDir: string,
): Promise<void> {
  // ── 5.1: Ensure schema_version table exists ─────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version        INTEGER PRIMARY KEY,
      applied_at     TEXT    NOT NULL,
      migration_name TEXT    NOT NULL
    )
  `);

  // Query MAX(version); rows[0].version is NULL when the table is empty.
  const versionResult = await db.query<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_version',
  );
  const currentVersion: number = versionResult.rows[0]?.version ?? 0;

  // ── 5.2: Discover migration files ────────────────────────────────────────
  const migrationFilePattern = /^\d+_.*\.sql$/;

  const files = readdirSync(migrationsDir)
    .filter(f => migrationFilePattern.test(f))
    .sort((a, b) => {
      const va = parseInt(a.split('_')[0]!, 10);
      const vb = parseInt(b.split('_')[0]!, 10);
      return va - vb;
    });

  // ── 5.6: Wall-clock timeout tracking ─────────────────────────────────────
  const startTime = Date.now();

  // ── 5.3: Apply pending migrations ────────────────────────────────────────
  for (const file of files) {
    const version = parseInt(file.split('_')[0]!, 10);

    // Skip already-applied migrations (M === N → skip; M < N → apply).
    if (version <= currentVersion) continue;

    // Check total wall-clock time before attempting the next migration.
    const elapsedBeforeApply = Date.now() - startTime;
    if (elapsedBeforeApply >= MIGRATION_TIMEOUT_MS) {
      throw new Error(
        `Migration timeout: total migration time exceeded ${MIGRATION_TIMEOUT_MS}ms ` +
        `before applying migration ${version}`,
      );
    }

    const rawSql = readFileSync(join(migrationsDir, file), 'utf-8');
    // Split the file into individual statements so bun:sqlite's prepare()
    // executes every statement — not just the first one (see splitStatements).
    const statements = splitStatements(rawSql);
    const migrationStart = Date.now();

    // ── 5.4 / 5.5: Run migration + schema_version insert in one transaction.
    // We need to distinguish between a migration error (rollback succeeded)
    // and a rollback error. DbAdapter.transaction() re-throws the original
    // migration error when ROLLBACK succeeds, but throws the ROLLBACK error
    // (replacing the original) when ROLLBACK itself fails.
    //
    // Strategy: capture the migration error inside the transaction callback,
    // then re-throw it after the transaction so we can detect which error
    // `transaction()` ultimately surfaces.
    let capturedMigrationError: unknown = undefined;

    try {
      await db.transaction(async (tx: DbAdapter) => {
        try {
          for (const stmt of statements) {
            await tx.execute(stmt);
          }
          await tx.execute(
            `INSERT INTO schema_version (version, applied_at, migration_name)
             VALUES (?, datetime('now'), ?)`,
            [version, file],
          );
        } catch (migrationErr) {
          capturedMigrationError = migrationErr;
          throw migrationErr; // propagate so the adapter triggers ROLLBACK
        }
      });
    } catch (transactionErr) {
      // Determine whether the error surfaced by transaction() is the original
      // migration error (rollback succeeded) or a different error (rollback
      // itself failed, replacing the original throw).
      if (capturedMigrationError !== undefined &&
          transactionErr !== capturedMigrationError) {
        // ROLLBACK threw a different error — log both failures.
        const migrationReason = errorMessage(capturedMigrationError);
        const rollbackReason  = errorMessage(transactionErr);
        console.error(`migration ${version} failed: ${migrationReason}`);
        console.error(`migration ${version} rollback failed: ${rollbackReason}`);
        throw transactionErr;
      }

      // Normal failure path: migration failed, rollback succeeded.
      const reason = errorMessage(transactionErr);
      console.error(`migration ${version} failed: ${reason}`);
      throw transactionErr;
    }

    // ── 10.3: Log applied migration with duration ─────────────────────────
    const duration = Date.now() - migrationStart;
    console.log(`Applied migration ${version} (${file}) in ${duration}ms`);

    // ── 5.6: Check wall-clock total after each applied migration ──────────
    const elapsed = Date.now() - startTime;
    if (elapsed >= MIGRATION_TIMEOUT_MS) {
      throw new Error(
        `Migration timeout: total migration time exceeded ${MIGRATION_TIMEOUT_MS}ms ` +
        `after applying migration ${version}`,
      );
    }
  }
}

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * @param err Any caught value
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
