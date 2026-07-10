/**
 * DbSyncTool — synchronises the file system into the database.
 *
 * Two entry-points:
 *  - `runFullSync(workspaceId)` — scans all jobs/chains/sessions and upserts
 *    every record in a single transaction.
 *  - `syncFile(filePath, workspaceId)` — stat a single file; soft-deletes when
 *    absent, parses and upserts when present.
 *
 * Security invariants:
 *  - All SQL is fully parameterised — no string interpolation of user data.
 *  - `filePath` is validated against path-traversal sequences before use.
 *
 * Requirements: 2.1, 2.4, 2.5, 2.7, 6.1, 6.2, 6.3, 6.4, 6.5, 11.1, 11.2
 */

import { statSync } from 'node:fs';
import { sep, normalize } from 'node:path';
import type { DbAdapter } from './adapter.js';
import type { Job, Chain, SessionState } from '../types.js';
import { scanJobs } from '../scan/jobs.js';
import { scanChains } from '../scan/chains.js';
import { scanSessions } from '../scan/sessions.js';

// ---------------------------------------------------------------------------
// Path sanitization (Requirement 11.2)
// ---------------------------------------------------------------------------

/**
 * Throws a `RangeError` when `filePath` contains path-traversal sequences.
 *
 * Rejected patterns:
 *  - Any `..` segment (e.g. `../../etc/passwd`)
 *  - Consecutive separator runs that could escape the monitored root
 *    (e.g. `//absolute`, `\\UNC`)
 */
function assertSafePath(filePath: string): void {
  // Reject literal `..` segments
  if (filePath.includes('..')) {
    throw new RangeError(`Unsafe file path rejected (contains '..'): ${filePath}`);
  }

  // Reject separator sequences: two or more consecutive separators
  // Covers both POSIX (//) and Windows (\\, /\, \/)
  const sepPattern = /[/\\]{2,}/;
  if (sepPattern.test(filePath)) {
    throw new RangeError(
      `Unsafe file path rejected (consecutive separators): ${filePath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Upsert helpers (all parameterised)
// ---------------------------------------------------------------------------

async function upsertJob(tx: DbAdapter, job: Job, now: number): Promise<void> {
  await tx.execute(
    `INSERT INTO jobs (
       id, workspace_id, name, job_chain, session_chain_id,
       timestamp, type, agent, status, lines, last_line,
       has_log, log_error, md_file, log_file, agent_done,
       size_bytes, last_modified, deleted_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       name             = excluded.name,
       job_chain        = excluded.job_chain,
       session_chain_id = excluded.session_chain_id,
       timestamp        = excluded.timestamp,
       type             = excluded.type,
       agent            = excluded.agent,
       status           = excluded.status,
       lines            = excluded.lines,
       last_line        = excluded.last_line,
       has_log          = excluded.has_log,
       log_error        = excluded.log_error,
       md_file          = excluded.md_file,
       log_file         = excluded.log_file,
       agent_done       = excluded.agent_done,
       size_bytes       = excluded.size_bytes,
       last_modified    = excluded.last_modified`,
    [
      job.id,
      job.workspaceId,
      job.name,
      job.jobChain,
      job.sessionChainId,
      job.timestamp,
      job.type,
      job.agent,
      job.status,
      job.lines,
      job.lastLine,
      job.hasLog ? 1 : 0,
      job.logError ? 1 : 0,
      job.mdFile,
      job.logFile,
      job.agentDone,
      job.sizeBytes,
      now,
    ],
  );
}

async function upsertChain(tx: DbAdapter, chain: Chain, now: number): Promise<void> {
  await tx.execute(
    `INSERT INTO chains (
       chain_id, workspace_id, display_name,
       created_at, last_active_at, total_messages,
       last_modified, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(chain_id) DO UPDATE SET
       display_name   = excluded.display_name,
       last_active_at = excluded.last_active_at,
       total_messages = excluded.total_messages,
       last_modified  = excluded.last_modified`,
    [
      chain.chainId,
      chain.workspaceId,
      chain.displayName,
      chain.createdAt,
      chain.lastActiveAt,
      chain.totalMessages,
      now,
    ],
  );
}

async function upsertSession(
  tx: DbAdapter,
  session: SessionState,
  now: number,
): Promise<void> {
  await tx.execute(
    `INSERT INTO sessions (
       chain_id, workspace_id, workflow_hash,
       chain_index, status, message_count,
       context_usage_pct, last_message_at,
       last_modified, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(chain_id, workflow_hash) DO UPDATE SET
       chain_index       = excluded.chain_index,
       status            = excluded.status,
       message_count     = excluded.message_count,
       context_usage_pct = excluded.context_usage_pct,
       last_message_at   = excluded.last_message_at,
       last_modified     = excluded.last_modified`,
    [
      session.chainId,
      session.workspaceId,
      session.workflowHash,
      session.chainIndex,
      session.status,
      session.messageCount,
      session.contextUsagePct,
      session.lastMessageAt,
      now,
    ],
  );
}

// ---------------------------------------------------------------------------
// DbSyncTool
// ---------------------------------------------------------------------------

export class DbSyncTool {
  constructor(private readonly db: DbAdapter) {}

  /**
   * Full workspace sync — scans all jobs, chains, and sessions then upserts
   * them all within a single transaction (Requirement 2.1, 6.1, 6.2).
   *
   * `last_modified` is set to `Date.now()` on every upsert.
   * Existing `deleted_at` is preserved because the ON CONFLICT clause only
   * updates non-deleted_at columns (Requirement 2.5).
   *
   * @param workspaceId Workspace identifier used for all scanned records.
   */
  async runFullSync(workspaceId: string): Promise<void> {
    const [jobs, chains, sessions] = await Promise.all([
      scanJobs(undefined, workspaceId),
      scanChains(undefined, [], workspaceId),
      scanSessions(undefined, workspaceId),
    ]);

    const now = Date.now();

    await this.db.transaction(async (tx) => {
      for (const job of jobs) {
        await upsertJob(tx, job, now);
      }
      for (const chain of chains) {
        await upsertChain(tx, chain, now);
      }
      for (const session of sessions) {
        await upsertSession(tx, session, now);
      }
    });
  }

  /**
   * Incremental single-file sync (Requirement 6.3, 6.4, 11.2).
   *
   * - If the file is absent (stat returns `undefined`): sets `deleted_at` on
   *   any matching job row (matched by `md_file` or `log_file` columns).
   * - If the file is present: delegates back to `runFullSync` for the
   *   workspace so the record is re-parsed and upserted with fresh data.
   *
   * Path traversal sequences are rejected before any I/O.
   *
   * @param filePath   Absolute or relative path to the changed file.
   * @param workspaceId Workspace this file belongs to.
   */
  async syncFile(filePath: string, workspaceId: string): Promise<void> {
    assertSafePath(filePath);

    const stat = statSync(filePath, { throwIfNoEntry: false });

    if (!stat) {
      // File absent — soft-delete matching job rows (Requirement 2.4, 6.4)
      await this.db.execute(
        `UPDATE jobs
            SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE workspace_id = ?
            AND (md_file = ? OR log_file = ?)
            AND deleted_at IS NULL`,
        [workspaceId, filePath, filePath],
      );
      return;
    }

    // File present — re-sync the workspace so the record is fully upserted
    await this.runFullSync(workspaceId);
  }
}
