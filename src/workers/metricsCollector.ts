// ---------------------------------------------------------------------------
// metricsCollector.ts — watches outputDir for .log file changes and extracts
// per-job metrics, upserting them into the job_metrics table.
//
// Exports:
//   startMetricsCollector(db, outputDir) — start the fs.watch watcher
//
// Error handling (AC 1.5, AC 10.2):
//   - Structural file-read failure → abort entire job, log error, continue
//   - Per-field extraction failure → store NULL, log warning, continue
//   - Outer catch per file → log error, continue processing other jobs
//
// Numeric bounds (AC 1.6):
//   - Any extracted value < 0 → stored as NULL
// ---------------------------------------------------------------------------

import { watch, readFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { DbAdapter } from '../db/adapter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All nullable metric fields extracted from a single log file. */
type ExtractedMetrics = {
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  tool_calls: number | null;
  retry_count: number | null;
  error_count: number | null;
};

// ---------------------------------------------------------------------------
// Guard: enforce non-negative numeric bound (AC 1.6)
// Returns null for negative values and for NaN/non-finite values.
// ---------------------------------------------------------------------------

function nonNegative(value: number): number | null {
  return isFinite(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Per-field extraction helpers — each returns (value | null) and logs a
// warning on individual failure (AC 1.5).
// ---------------------------------------------------------------------------

function extractNumber(
  content: string,
  pattern: RegExp,
  fieldName: string,
  jobId: string,
  transform: (raw: string) => number = parseFloat,
): number | null {
  const match = content.match(pattern);
  if (!match) {
    return null; // field absent — not an error, just missing data
  }
  const raw = match[1];
  const value = transform(raw);
  if (!isFinite(value)) {
    console.warn(`metric extraction failed for ${jobId}: ${fieldName}: parsed NaN from "${raw}"`);
    return null;
  }
  const bounded = nonNegative(value);
  if (bounded === null) {
    console.warn(`metric extraction failed for ${jobId}: ${fieldName}: value ${value} is negative`);
  }
  return bounded;
}

// ---------------------------------------------------------------------------
// extractMetrics — parse all fields from log content.
//
// Supports two log formats:
//
//  1. Kiro sw-agent summary line (actual format):
//       [sw-agent] done in 328.5s, ~197629 tokens
//
//  2. Structured metric lines (richer future / alternative format):
//       Duration: 1234ms
//       Input tokens: 1000
//       Output tokens: 500
//       Cost: $0.0123
//       Tool calls: 42
//       Retry count: 2  |  Retries: 2
//       Error count: 1  |  Errors: 1
// ---------------------------------------------------------------------------

function extractMetrics(content: string, jobId: string): ExtractedMetrics {
  let duration_ms: number | null = null;
  let input_tokens: number | null = null;
  let output_tokens: number | null = null;
  let cost_usd: number | null = null;

  // --- sw-agent summary line: "done in 328.5s, ~197629 tokens" --------------
  // Duration from seconds → milliseconds
  const swAgentMatch = content.match(/done\s+in\s+([\d.]+)s[,\s]/i);
  if (swAgentMatch) {
    const secs = parseFloat(swAgentMatch[1]);
    if (isFinite(secs)) {
      const ms = secs * 1_000;
      duration_ms = nonNegative(ms);
      if (duration_ms === null) {
        console.warn(`metric extraction failed for ${jobId}: duration_ms: value ${ms} is negative`);
      }
    }
  }

  // Total tokens from sw-agent line: "~197629 tokens"
  // These are approximate totals — stored in total_tokens directly when
  // individual in/out token counts are unavailable.
  const swTokenMatch = content.match(/~(\d+)\s+tokens/i);
  let swTotalTokens: number | null = null;
  if (swTokenMatch) {
    const raw = parseInt(swTokenMatch[1], 10);
    swTotalTokens = isFinite(raw) ? nonNegative(raw) : null;
  }

  // --- Structured metric lines (richer format) ------------------------------

  // Duration: 1234ms (overrides sw-agent if both present)
  const structuredDuration = extractNumber(
    content,
    /^Duration:\s*(-?\d+(?:\.\d+)?)ms/im,
    'duration_ms',
    jobId,
    parseFloat,
  );
  if (structuredDuration !== null) {
    duration_ms = structuredDuration;
  }

  // Input tokens: 1000
  input_tokens = extractNumber(
    content,
    /^Input tokens:\s*(-?\d+)/im,
    'input_tokens',
    jobId,
    parseInt,
  );

  // Output tokens: 500
  output_tokens = extractNumber(
    content,
    /^Output tokens:\s*(-?\d+)/im,
    'output_tokens',
    jobId,
    parseInt,
  );

  // Cost: $0.0123
  cost_usd = extractNumber(
    content,
    /^Cost:\s*\$(-?[\d.]+)/im,
    'cost_usd',
    jobId,
    parseFloat,
  );

  // --- Tool calls -----------------------------------------------------------
  const tool_calls = extractNumber(
    content,
    /^Tool calls:\s*(-?\d+)/im,
    'tool_calls',
    jobId,
    parseInt,
  );

  // --- Retry count ----------------------------------------------------------
  const retry_count =
    extractNumber(content, /^Retry count:\s*(-?\d+)/im, 'retry_count', jobId, parseInt) ??
    extractNumber(content, /^Retries:\s*(-?\d+)/im, 'retry_count', jobId, parseInt);

  // --- Error count ----------------------------------------------------------
  const error_count =
    extractNumber(content, /^Error count:\s*(-?\d+)/im, 'error_count', jobId, parseInt) ??
    extractNumber(content, /^Errors:\s*(-?\d+)/im, 'error_count', jobId, parseInt);

  // --- Compute total_tokens -------------------------------------------------
  // Prefer structured in+out sum; fall back to sw-agent approximate total.
  let total_tokens: number | null = null;
  if (input_tokens !== null && output_tokens !== null) {
    total_tokens = nonNegative(input_tokens + output_tokens);
  } else if (swTotalTokens !== null) {
    total_tokens = swTotalTokens;
  }

  return {
    duration_ms,
    input_tokens,
    output_tokens,
    total_tokens,
    cost_usd,
    tool_calls,
    retry_count,
    error_count,
  };
}

// ---------------------------------------------------------------------------
// extractJobId — derive job_id from the log file path.
// Uses the filename stem (without extension) as the job identifier.
// ---------------------------------------------------------------------------

function extractJobId(logPath: string): string {
  return path.basename(logPath, '.log');
}

// ---------------------------------------------------------------------------
// extractWorkspaceId — derive workspace_id from the log file path.
//
// Strategy: look for a parent directory that looks like a workspace slug.
// Falls back to "default" when no recognisable workspace segment is found.
// ---------------------------------------------------------------------------

function extractWorkspaceId(logPath: string): string {
  // Walk the directory segments looking for known workspace patterns.
  // Many deployments use a flat output dir — use "default" as the fallback.
  const parts = logPath.replace(/\\/g, '/').split('/');

  // A workspace-id segment is expected to be a slug-like identifier.
  // Look for segments that contain only word chars and hyphens (not too long)
  // and sit in positions that are parent directories of the file.
  for (let i = parts.length - 2; i >= 0; i--) {
    const segment = parts[i];
    // Heuristic: matches slug-like names but not generic system dirs
    if (/^[a-z0-9][a-z0-9-]{1,40}$/.test(segment)) {
      return segment;
    }
  }

  return 'default';
}

// ---------------------------------------------------------------------------
// upsertMetrics — write extracted metrics to job_metrics via ON CONFLICT upsert
// ---------------------------------------------------------------------------

async function upsertMetrics(
  db: DbAdapter,
  jobId: string,
  workspaceId: string,
  metrics: ExtractedMetrics,
): Promise<void> {
  const collectedAt = new Date().toISOString();

  await db.execute(
    `INSERT INTO job_metrics (
       job_id, workspace_id, duration_ms, input_tokens, output_tokens,
       total_tokens, cost_usd, tool_calls, retry_count, error_count, collected_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       workspace_id  = excluded.workspace_id,
       duration_ms   = excluded.duration_ms,
       input_tokens  = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       total_tokens  = excluded.total_tokens,
       cost_usd      = excluded.cost_usd,
       tool_calls    = excluded.tool_calls,
       retry_count   = excluded.retry_count,
       error_count   = excluded.error_count,
       collected_at  = excluded.collected_at`,
    [
      jobId,
      workspaceId,
      metrics.duration_ms,
      metrics.input_tokens,
      metrics.output_tokens,
      metrics.total_tokens,
      metrics.cost_usd,
      metrics.tool_calls,
      metrics.retry_count,
      metrics.error_count,
      collectedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// extractAndStore — read one .log file, extract metrics, upsert to DB.
//
// AC 1.5: structural read failure aborts the whole job.
//         Individual field failures store NULL and log a warning.
// AC 10.2: exceptions are caught in the caller (processLogFile).
// ---------------------------------------------------------------------------

async function extractAndStore(db: DbAdapter, logPath: string): Promise<void> {
  const jobId = extractJobId(logPath);
  const workspaceId = extractWorkspaceId(logPath);

  // Structural read — failure aborts this job entirely (AC 1.5)
  let content: string;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[ERROR] [metrics-collector] failed to read log for ${jobId}:\n${stack}`);
    return; // abort this job, caller continues with others
  }

  const metrics = extractMetrics(content, jobId);
  await upsertMetrics(db, jobId, workspaceId, metrics);
}

// ---------------------------------------------------------------------------
// In-flight deduplication — prevent re-processing the same file concurrently
// when fs.watch fires multiple events for a single write.
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();

// ---------------------------------------------------------------------------
// processLogFile — outer wrapper with try/catch per AC 10.2.
// Deduplicates concurrent events for the same path.
// ---------------------------------------------------------------------------

async function processLogFile(db: DbAdapter, logPath: string): Promise<void> {
  if (inFlight.has(logPath)) return;
  inFlight.add(logPath);

  try {
    // Brief delay to let the writer flush content before we read.
    // fs.watch may fire on file creation (before content is written).
    await new Promise<void>((r) => setTimeout(r, 50));
    await extractAndStore(db, logPath);
  } catch (err) {
    // AC 10.2: log error, continue processing other jobs
    const jobId = extractJobId(logPath);
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[ERROR] [metrics-collector] error processing ${jobId}:\n${stack}`);
  } finally {
    inFlight.delete(logPath);
  }
}

// ---------------------------------------------------------------------------
// startMetricsCollector — public API.
// Starts a recursive fs.watch on outputDir and processes .log file changes.
// ---------------------------------------------------------------------------

export function startMetricsCollector(db: DbAdapter, outputDir: string): FSWatcher {
  const watcher = watch(outputDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (!filename.endsWith('.log')) return;

    // Resolve to absolute path (filename may be relative to outputDir)
    const logPath = path.isAbsolute(filename)
      ? filename
      : path.join(outputDir, filename);

    processLogFile(db, logPath).catch(err => {
      // Belt-and-suspenders: processLogFile already catches, but protect the
      // watch callback from any unexpected rejection propagation.
      const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`[ERROR] [metrics-collector] unexpected error for ${filename}:\n${stack}`);
    });
  });

  console.log(`[metrics-collector] watching ${outputDir} for .log file changes`);
  return watcher;
}
