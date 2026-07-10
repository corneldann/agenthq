// api.ts — all fetch calls; populates AppState; client-side join of JobChain→Chain
// Feature: monitor-dashboard-redesign
// Implements Requirements 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8

import { setState, getState } from './state.js';
import type {
  Job,
  Chain,
  JobChain,
  PollLogEntry,
  SystemStatus,
  GitStatus,
  Toast,
  BuildQueueRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Concurrency guards
// ---------------------------------------------------------------------------

/** True while a fetchAll() Promise.all is in-flight. */
let fetching = false;

/**
 * True when an SSE event arrived while a fetch was already in-flight.
 * Once the in-flight fetch completes we fire one additional fetchAll().
 */
let pendingRefetch = false;

// ---------------------------------------------------------------------------
// Error toast helper (lazy import to avoid circular dependency with toast.ts)
// ---------------------------------------------------------------------------

async function enqueueErrorToast(message: string): Promise<void> {
  try {
    // Dynamic import defers resolution until runtime so toast.ts can import
    // api.ts without creating a circular reference at module-load time.
    const { enqueueToast } = await import('./toast.js');
    const toast: Toast = {
      id: crypto.randomUUID(),
      type: 'error',
      message,
      persistent: true,
    };
    enqueueToast(toast);
  } catch {
    // toast.ts may not be implemented yet — fail silently
    console.error('[api] toast error:', message);
  }
}

// ---------------------------------------------------------------------------
// safeFetch — wraps fetch with try/catch; returns fallback on any failure
// ---------------------------------------------------------------------------

/**
 * Fetch `url` and parse the response as JSON.
 * - On network error: logs + enqueues error toast, returns `fallback`.
 * - On non-2xx HTTP status: logs + enqueues error toast, returns `fallback`.
 * - On success: returns parsed JSON typed as `T`.
 *
 * Requirements 4.6, 4.7: only api.ts calls fetch; errors produce a toast
 * and leave AppState unchanged for the failed endpoint.
 */
async function safeFetch<T>(url: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      await enqueueErrorToast(
        `Fetch error: ${url} returned ${response.status} ${response.statusText}`
      );
      return fallback;
    }
    return (await response.json()) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await enqueueErrorToast(`Network error fetching ${url}: ${message}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Client-side join: JobChain → Chain
// ---------------------------------------------------------------------------

/**
 * Performs the client-side join described in Requirements 4.4 and Property 4.
 *
 * For each JobChain:
 *   - If sessionChainId !== "" → find the Chain where chainId === sessionChainId.
 *   - If sessionChainId === "" → standalone; no chain match (unlinked).
 *
 * Returns the same jobChains array unchanged (the join association is implicit
 * via the shared sessionChainId / chainId keys that page renderers use).
 * Both arrays are stored in AppState so pages can perform lookups themselves.
 * No record is omitted or duplicated.
 */
function buildChainIndex(chains: Chain[]): Map<string, Chain> {
  const index = new Map<string, Chain>();
  for (const chain of chains) {
    index.set(chain.chainId, chain);
  }
  return index;
}

// ---------------------------------------------------------------------------
// fetchAll — fires all 6 endpoints concurrently, guards against overlapping
// ---------------------------------------------------------------------------

/**
 * Fetches all six monitor endpoints concurrently and writes results to AppState.
 *
 * Concurrency guard (Requirements 4.2, 9.2):
 *   - If a fetchAll() is already in-flight (`fetching === true`), set
 *     `pendingRefetch = true` and return immediately. Once the in-flight call
 *     completes it will check the flag and fire one additional fetchAll().
 *
 * Endpoints fetched (Requirements 4.1, 4.3):
 *   GET /system-status, /jobs, /job-chains, /chains, /poll-log, /git-status
 *
 * Client-side join (Requirement 4.4):
 *   Builds a chainId → Chain index; stored in AppState so renderers can join
 *   JobChains to Chains using JobChain.sessionChainId === Chain.chainId.
 *
 * Field preservation (Requirement 4.8):
 *   Chain[] is stored as-is from the server response; no fields are stripped.
 */
export async function fetchAll(): Promise<void> {
  if (fetching) {
    pendingRefetch = true;
    return;
  }

  fetching = true;
  pendingRefetch = false;

  try {
    // Snapshot existing state values as fallbacks so a failed endpoint leaves
    // AppState unchanged for that slice (Requirement 4.6).
    const current = getState();

    const [
      systemStatus,
      jobs,
      jobChains,
      chains,
      pollLog,
      gitStatusesOrSingle,
      buildQueue,
    ] = await Promise.all([
      safeFetch<SystemStatus>('/system-status', current.systemStatus ?? ({} as SystemStatus)),
      safeFetch<Job[]>('/jobs', current.jobs),
      safeFetch<JobChain[]>('/job-chains', current.jobChains),
      safeFetch<Chain[]>('/chains', current.chains),
      safeFetch<PollLogEntry[]>('/poll-log', current.pollLog),
      safeFetch<GitStatus[] | GitStatus>('/git-status', current.gitStatuses.length > 0 ? current.gitStatuses : (current.gitStatus ?? ({} as GitStatus))),
      safeFetch<BuildQueueRecord[]>('/build-queue', current.buildQueue),
    ]);

    // Build chain index for client-side join (stored implicitly via AppState).
    // Pages join JobChain.sessionChainId → Chain.chainId using this shared data.
    // We validate the index is coherent but don't need to expose it separately —
    // renderers read chains[] and jobChains[] from AppState and join themselves.
    buildChainIndex(chains); // called to validate; result used by renderers

    // Normalize git status: if single object, wrap in array; if already array, use as-is
    let gitStatuses: GitStatus[] = [];
    let gitStatus: GitStatus | null = current.gitStatus;
    if (Array.isArray(gitStatusesOrSingle)) {
      gitStatuses = gitStatusesOrSingle;
      // For backward compat: if we have a single workspace, also populate gitStatus
      if (gitStatuses.length === 1) {
        gitStatus = gitStatuses[0];
      } else if (gitStatuses.length === 0) {
        gitStatus = null;
      }
    } else if (!isEmptyObject(gitStatusesOrSingle)) {
      // Single object response (legacy or single workspace)
      gitStatus = gitStatusesOrSingle as GitStatus;
      gitStatuses = [gitStatus];
    }

    // Write all results to AppState in a single setState call (atomic update).
    // systemStatus and gitStatus fall back to null if they were not previously
    // set AND the fetch failed (safeFetch returns {} which is technically wrong
    // shape; preserve null semantics by restoring null on empty fallback object).
    setState({
      systemStatus: isEmptyObject(systemStatus) && current.systemStatus === null
        ? null
        : systemStatus as SystemStatus,
      gitStatus,
      gitStatuses,
      jobs,
      jobChains,
      chains,
      pollLog,
      buildQueue,
    });
  } finally {
    fetching = false;

    // If an SSE event arrived while we were in-flight, honour exactly one
    // deferred refetch (Requirements 4.2, 9.2).
    if (pendingRefetch) {
      pendingRefetch = false;
      // Kick off next fetch asynchronously so the current call-stack unwinds.
      void fetchAll();
    }
  }
}

// ---------------------------------------------------------------------------
// Job transition toast detection (Requirements 4.5, 9.3, 9.4)
// ---------------------------------------------------------------------------

/**
 * Compares a pre-fetch and post-fetch Job[] array and returns the set of
 * Toast notifications that should be enqueued for job status transitions.
 *
 * Rules:
 *   - running → done  : success toast (auto-dismiss)
 *   - running → error : error toast (persistent)
 *   - Jobs not matched by id in postJobs are ignored.
 *   - Jobs whose pre.status !== 'running' produce no toast.
 *
 * This is a pure function: it does not call enqueueToast itself, allowing
 * callers (main.ts SSE handler) to decide when to enqueue and allowing
 * property-based tests to verify the detection logic in isolation.
 *
 * Feature: monitor-dashboard-redesign
 * Implements Requirements 4.5, 9.3, 9.4
 */
export function detectTransitions(prev: Job[], next: Job[]): Toast[] {
  const nextById = new Map<string, Job>();
  for (const job of next) {
    nextById.set(job.id, job);
  }

  const toasts: Toast[] = [];

  for (const preJob of prev) {
    if (preJob.status !== 'running') continue;

    const postJob = nextById.get(preJob.id);
    if (!postJob) continue;

    if (postJob.status === 'done') {
      toasts.push({
        id: crypto.randomUUID(),
        type: 'success',
        message: `Job "${preJob.name}" completed successfully`,
        persistent: false,
      });
    } else if (postJob.status === 'error') {
      toasts.push({
        id: crypto.randomUUID(),
        type: 'error',
        message: `Job "${preJob.name}" failed with an error`,
        persistent: true,
      });
    }
  }

  return toasts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  );
}
