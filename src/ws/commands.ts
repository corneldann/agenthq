/**
 * WebSocket command handler.
 *
 * Executes agent control commands (cancel-job, pause-agent, resume-agent)
 * that arrive over the WebSocket connection. All mutations are persisted to
 * the database via the injected {@link DbAdapter}.
 *
 * All SQL uses parameterised queries — no string interpolation of external
 * input — to prevent injection attacks.
 */

import type { DbAdapter } from '../db/adapter.js';
import type { ClientMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** The outcome of a command dispatched through {@link CommandHandler.handle}. */
export type CommandResult = {
  success: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Row shapes returned by queries
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  workspace_id: string;
  status: string;
};

type SessionRow = {
  chain_id: string;
  workflow_hash: string;
  status: string;
};

// ---------------------------------------------------------------------------
// CommandHandler
// ---------------------------------------------------------------------------

/**
 * Handles interactive agent-control commands received over WebSocket.
 *
 * Requires a {@link DbAdapter} for reading current entity state and writing
 * status updates / history records.
 */
export class CommandHandler {
  constructor(private readonly db: DbAdapter) {}

  // -------------------------------------------------------------------------
  // Public dispatch method
  // -------------------------------------------------------------------------

  /**
   * Dispatch a {@link ClientMessage} to the appropriate handler.
   *
   * Returns `{ success: false, error: 'Unknown command type' }` for message
   * types that are not actionable commands (e.g. `ping`, `subscribe`).
   *
   * @param cmd Validated client message from `parseClientMessage`
   */
  async handle(cmd: ClientMessage): Promise<CommandResult> {
    switch (cmd.type) {
      case 'cancel-job':
        return this.handleCancelJob(cmd);

      case 'pause-agent':
        return this.handlePauseAgent(cmd);

      case 'resume-agent':
        return this.handleResumeAgent(cmd);

      default:
        return { success: false, error: 'Unknown command type' };
    }
  }

  // -------------------------------------------------------------------------
  // cancel-job
  // -------------------------------------------------------------------------

  /**
   * Cancel a running job by setting its status to `'error'` and recording
   * the transition in `job_status_history`.
   *
   * Fails fast with a descriptive error if the job is not found or the
   * workspace ID does not match.
   *
   * @param cmd The validated `cancel-job` message
   */
  private async handleCancelJob(
    cmd: Extract<ClientMessage, { type: 'cancel-job' }>,
  ): Promise<CommandResult> {
    const result = await this.db.query<JobRow>(
      'SELECT id, workspace_id, status FROM jobs WHERE id = ?',
      [cmd.jobId],
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'not found' };
    }

    const job = result.rows[0];

    if (job.workspace_id !== cmd.workspaceId) {
      return { success: false, error: 'workspace mismatch' };
    }

    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE jobs SET status = 'error', agent_done = ? WHERE id = ?`,
        [now, cmd.jobId],
      );

      await tx.execute(
        `INSERT INTO job_status_history
           (job_id, workspace_id, old_status, new_status, reason)
         VALUES (?, ?, ?, ?, ?)`,
        [cmd.jobId, cmd.workspaceId, job.status, 'error', 'cancelled by user'],
      );
    });

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // pause-agent
  // -------------------------------------------------------------------------

  /**
   * Pause a running agent session by transitioning it to `'paused'` status.
   *
   * Only sessions currently in `'running'` state may be paused; any other
   * state yields an `'invalid state transition'` error.
   *
   * @param cmd The validated `pause-agent` message
   */
  private async handlePauseAgent(
    cmd: Extract<ClientMessage, { type: 'pause-agent' }>,
  ): Promise<CommandResult> {
    const result = await this.db.query<SessionRow>(
      `SELECT chain_id, workflow_hash, status
         FROM sessions
        WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId],
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'not found' };
    }

    const session = result.rows[0];

    if (session.status !== 'running') {
      return {
        success: false,
        error: `invalid state transition: cannot pause from ${session.status}`,
      };
    }

    await this.db.execute(
      `UPDATE sessions SET status = 'paused'
        WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId],
    );

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // resume-agent
  // -------------------------------------------------------------------------

  /**
   * Resume a paused agent session by transitioning it back to `'running'`.
   *
   * Only sessions currently in `'paused'` state may be resumed; any other
   * state yields an `'invalid state transition'` error.
   *
   * @param cmd The validated `resume-agent` message
   */
  private async handleResumeAgent(
    cmd: Extract<ClientMessage, { type: 'resume-agent' }>,
  ): Promise<CommandResult> {
    const result = await this.db.query<SessionRow>(
      `SELECT chain_id, workflow_hash, status
         FROM sessions
        WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId],
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'not found' };
    }

    const session = result.rows[0];

    if (session.status !== 'paused') {
      return {
        success: false,
        error: `invalid state transition: cannot resume from ${session.status}`,
      };
    }

    await this.db.execute(
      `UPDATE sessions SET status = 'running'
        WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId],
    );

    return { success: true };
  }
}
