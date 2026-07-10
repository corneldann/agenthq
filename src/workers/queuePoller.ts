// Queue Poller — scans recently modified Kiro workflow files for CRAWL_QUEUE /
// CLONE_QUEUE / PROMPT_QUEUE / BUILD_QUEUE signals and dispatches the
// appropriate workers.  Runs every 10 s via startQueuePoller().
//
// Exports:
//   startQueuePoller            — starts the 10-second interval (call once at startup)
//   stopQueuePoller             — clears the interval (call during graceful shutdown)
//   readPollState               — reads persisted poll state from disk
//   pollLog                     — in-memory ring buffer of recent poll events
//   QueuePollerWorkspaceContext — workspace context for multi-workspace queue loading
//   loadQueues                  — load queue files from all configured workspaces
//   getDefaultWorkspaceContext  — builds workspace context from global constants (legacy/single-workspace)
//   processEntry                — dispatch a single queue entry in its owning workspace context

import path from "node:path";
import type { PollLogEntry, BackgroundJobRecord, BuildQueueRecord } from "../types.ts";
import {
  WORKSPACE_ROOT, WORKFLOW_DIR, CRAWL_JOBS_FILE, CLONE_JOBS_FILE,
  BUILD_QUEUE_FILE, KIRO_TOOLS_DIR, PROMPT_OUTPUT_DIR, POLL_LOG_MAX
} from "../constants.ts";
import { scanSessions } from "../scan/sessions.ts";
import { appendBackgroundJobRecord } from "../scan/jobs.ts";

// ---------------------------------------------------------------------------
// QueuePollerWorkspaceContext — per-workspace context for multi-workspace polling
// ---------------------------------------------------------------------------

/**
 * Context for loading queue files from a specific workspace.
 * Used by loadQueues() to aggregate entries from all configured workspaces.
 */
export interface QueuePollerWorkspaceContext {
  /** Unique workspace identifier (matches WorkspaceConfig.id) */
  workspaceId: string;
  /** Absolute path to the workspace root (used to resolve relative queue file paths) */
  workspaceRoot: string;
  /** Absolute or relative path to the crawl jobs file (relative paths resolved against workspaceRoot) */
  crawlJobsFile: string;
  /** Absolute or relative path to the clone jobs file (relative paths resolved against workspaceRoot) */
  cloneJobsFile: string;
  /** Absolute or relative path to the build queue file (relative paths resolved against workspaceRoot) */
  buildQueueFile: string;
}

// ---------------------------------------------------------------------------
// loadQueues — multi-workspace queue file loading
// ---------------------------------------------------------------------------

/**
 * Load queue files from all configured workspaces and aggregate entries.
 * Resolves relative paths against each workspace's WORKSPACE_ROOT.
 * Populates workspaceId on every returned record.
 *
 * @param workspaces Array of workspace contexts to load queues from
 * @returns Aggregated crawl, clone, and build queue entries across all workspaces
 */
export async function loadQueues(workspaces: QueuePollerWorkspaceContext[]): Promise<{
  crawlQueue: BackgroundJobRecord[];
  cloneQueue: BackgroundJobRecord[];
  buildQueue: BuildQueueRecord[];
}> {
  const crawlQueue: BackgroundJobRecord[] = [];
  const cloneQueue: BackgroundJobRecord[] = [];
  const buildQueue: BuildQueueRecord[] = [];

  for (const workspace of workspaces) {
    // Resolve queue file paths against workspace root if relative
    const crawlFile = path.isAbsolute(workspace.crawlJobsFile)
      ? workspace.crawlJobsFile
      : path.join(workspace.workspaceRoot, workspace.crawlJobsFile);

    const cloneFile = path.isAbsolute(workspace.cloneJobsFile)
      ? workspace.cloneJobsFile
      : path.join(workspace.workspaceRoot, workspace.cloneJobsFile);

    const buildFile = path.isAbsolute(workspace.buildQueueFile)
      ? workspace.buildQueueFile
      : path.join(workspace.workspaceRoot, workspace.buildQueueFile);

    // Load crawl queue entries
    try {
      const raw = await Bun.file(crawlFile).text();
      const entries = parseJsonlOrArray<BackgroundJobRecord>(raw);
      for (const entry of entries) {
        crawlQueue.push({ ...entry, workspaceId: workspace.workspaceId });
      }
    } catch {
      // File missing or unreadable — skip silently (workspace may not use this queue)
    }

    // Load clone queue entries
    try {
      const raw = await Bun.file(cloneFile).text();
      const entries = parseJsonlOrArray<BackgroundJobRecord>(raw);
      for (const entry of entries) {
        cloneQueue.push({ ...entry, workspaceId: workspace.workspaceId });
      }
    } catch {
      // File missing or unreadable — skip silently
    }

    // Load build queue entries
    try {
      const raw = await Bun.file(buildFile).text();
      const entries = parseJsonlOrArray<BuildQueueRecord>(raw);
      for (const entry of entries) {
        buildQueue.push({ ...entry, workspaceId: workspace.workspaceId });
      }
    } catch {
      // File missing or unreadable — skip silently
    }
  }

  return { crawlQueue, cloneQueue, buildQueue };
}

/**
 * Parse a file that may be either:
 *  - A JSON array: "[{...}, {...}]"
 *  - JSONL (newline-delimited JSON): one JSON object per line
 *
 * Returns an empty array on any parse failure.
 */
function parseJsonlOrArray<T>(raw: string): T[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Try JSON array first
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      // fall through to JSONL
    }
  }

  // Try JSONL
  const results: T[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      results.push(JSON.parse(l) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Worker-local configuration constants
// ---------------------------------------------------------------------------

const CRAWL_WORKER  = path.join(KIRO_TOOLS_DIR, "batch_crawl_worker.py");
const CLONE_WORKER  = path.join(KIRO_TOOLS_DIR, "clone_worker.py");
const PROMPT_WORKER = path.join(KIRO_TOOLS_DIR, "sw_agent_worker.ps1");
const PYTHON_PATH   = path.join(KIRO_TOOLS_DIR, ".venv", "Scripts", "python.exe");

// ---------------------------------------------------------------------------
// getDefaultWorkspaceContext — builds workspace context from global constants
// Used for legacy single-workspace mode when no multi-workspace config is loaded
// ---------------------------------------------------------------------------

/**
 * Returns a QueuePollerWorkspaceContext built from the global environment constants.
 * This is used by pollQueues() to identify the owning workspace of dispatched entries
 * even in single-workspace (legacy) mode.
 *
 * The workspaceId defaults to "default" when WORKSPACE_ROOT is not set.
 * When WORKSPACE_ROOT is set, a slug is derived from the last path segment.
 *
 * Requirement 8.5: all dispatched entries must have workspaceId populated.
 */
export function getDefaultWorkspaceContext(): QueuePollerWorkspaceContext {
  // Derive a workspace ID from the WORKSPACE_ROOT path (last non-empty segment),
  // falling back to "default" if the path is empty.
  const workspaceRoot = WORKSPACE_ROOT;
  let workspaceId = "default";
  if (workspaceRoot) {
    const lastSegment = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    if (lastSegment) workspaceId = lastSegment;
  }

  return {
    workspaceId,
    workspaceRoot,
    crawlJobsFile: CRAWL_JOBS_FILE,
    cloneJobsFile: CLONE_JOBS_FILE,
    buildQueueFile: BUILD_QUEUE_FILE,
  };
}

// ---------------------------------------------------------------------------
// processEntry — dispatch a single queue entry in its owning workspace context
// ---------------------------------------------------------------------------

/**
 * Process a single BackgroundJobRecord or BuildQueueRecord in the context of
 * its owning workspace. Resolves all paths against the workspace's WORKSPACE_ROOT.
 *
 * The entry's workspaceId must already be populated (set during loadQueues).
 * This function is responsible for the actual execution/dispatch logic for
 * entries loaded from workspace-specific queue files.
 *
 * Requirements 8.2, 8.3, 8.4: process crawl/clone/build entries in owning workspace.
 * Requirement 8.5: entry workspaceId is preserved (already set during loadQueues).
 */
export async function processEntry(
  entry: BackgroundJobRecord | BuildQueueRecord,
  workspace: QueuePollerWorkspaceContext,
): Promise<void> {
  const isBuildRecord = "target" in entry && (entry as BuildQueueRecord).target !== undefined;

  if (isBuildRecord) {
    const buildEntry = entry as BuildQueueRecord;
    if (buildEntry.target !== "dashboard") return;

    // Resolve build queue file path against workspace root
    const buildFile = path.isAbsolute(workspace.buildQueueFile)
      ? workspace.buildQueueFile
      : path.join(workspace.workspaceRoot, workspace.buildQueueFile);

    const swAgentDir = path.join(workspace.workspaceRoot, "agenthq");
    const buildProc = Bun.spawn(
      ["cmd", "/c", "npm", "run", "build:dashboard"],
      { cwd: swAgentDir, stdout: "ignore", stderr: "ignore" },
    );

    // Update status to "building"
    const buildingRecord: BuildQueueRecord = {
      ...buildEntry,
      status: "building",
      workspaceId: workspace.workspaceId,
    };
    const lines = await Bun.file(buildFile).text().catch(() => "");
    const updated = lines
      .split("\n")
      .filter(l => l.trim())
      .map(l => {
        try {
          const r = JSON.parse(l) as BuildQueueRecord;
          return r.stem === buildEntry.stem ? JSON.stringify(buildingRecord) : l;
        } catch { return l; }
      })
      .join("\n") + "\n";
    await Bun.write(buildFile, updated);

    const exitCode = await buildProc.exited;
    const finalRecord: BuildQueueRecord = {
      ...buildEntry,
      status: exitCode === 0 ? "done" : "error",
      workspaceId: workspace.workspaceId,
    };
    const lines2 = await Bun.file(buildFile).text().catch(() => "");
    const updated2 = lines2
      .split("\n")
      .filter(l => l.trim())
      .map(l => {
        try {
          const r = JSON.parse(l) as BuildQueueRecord;
          return r.stem === buildEntry.stem ? JSON.stringify(finalRecord) : l;
        } catch { return l; }
      })
      .join("\n") + "\n";
    await Bun.write(buildFile, updated2);
    console.log(`[queue-poller] processEntry BUILD: ${buildEntry.stem} → ${finalRecord.status} (workspace: ${workspace.workspaceId})`);
  } else {
    const bgEntry = entry as BackgroundJobRecord;
    // Resolve crawl/clone job file paths against workspace root
    const jobFile = bgEntry.type === "crawl"
      ? (path.isAbsolute(workspace.crawlJobsFile)
          ? workspace.crawlJobsFile
          : path.join(workspace.workspaceRoot, workspace.crawlJobsFile))
      : (path.isAbsolute(workspace.cloneJobsFile)
          ? workspace.cloneJobsFile
          : path.join(workspace.workspaceRoot, workspace.cloneJobsFile));

    const workerScript = bgEntry.type === "crawl" ? CRAWL_WORKER : CLONE_WORKER;
    const python = Bun.which("python") ? PYTHON_PATH : "python";
    Bun.spawn([python, workerScript, jobFile], {
      cwd: workspace.workspaceRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    console.log(`[queue-poller] processEntry ${bgEntry.type.toUpperCase()}: ${bgEntry.stem} (workspace: ${workspace.workspaceId})`);
  }
}

// queuePoller.ts lives under workers/ — one extra ".." to reach agenthq/
const POLL_STATE_FILE = path.join(path.resolve(import.meta.dir, ".."), "..", ".poll-state.json");

// ---------------------------------------------------------------------------
// Poll state — persisted across restarts so we only re-scan the gap window
// ---------------------------------------------------------------------------

type PollState = { lastPollTime: number; processed: string[] };

// In-memory set of processed workflow hashes — prevents double-dispatch
const processedQueues = new Set<string>();

export async function readPollState(): Promise<PollState> {
  try {
    const raw = await Bun.file(POLL_STATE_FILE).text();
    const state = JSON.parse(raw) as Partial<PollState>;
    const lastPollTime = typeof state.lastPollTime === "number" ? state.lastPollTime : 0;
    const processed = Array.isArray(state.processed) ? state.processed : [];
    for (const h of processed) processedQueues.add(h);
    return { lastPollTime, processed };
  } catch {
    return { lastPollTime: 0, processed: [] };
  }
}

async function writePollState(ts: number): Promise<void> {
  try {
    const state: PollState = {
      lastPollTime: ts,
      processed: [...processedQueues],
    };
    await Bun.write(POLL_STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error(`[queue-poller] failed to write poll state: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Poll log — in-memory ring buffer (last POLL_LOG_MAX entries)
// ---------------------------------------------------------------------------

export const pollLog: PollLogEntry[] = [];

function appendPollLog(entry: PollLogEntry): void {
  pollLog.push(entry);
  if (pollLog.length > POLL_LOG_MAX) pollLog.shift();
}

// ---------------------------------------------------------------------------
// Python / PowerShell worker spawning
// ---------------------------------------------------------------------------

function spawnPythonWorker(workerScript: string, queueFile: string, workspaceRoot: string): void {
  const python = Bun.which("python") ? PYTHON_PATH : "python";
  Bun.spawn([python, workerScript, queueFile], {
    cwd: workspaceRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
}

// ---------------------------------------------------------------------------
// Core poll logic — reads workflow files and dispatches signals
// ---------------------------------------------------------------------------

async function pollQueues(): Promise<void> {
  // Resolve the default workspace context for this poll cycle.
  // In multi-workspace mode, the caller would pass workspace contexts;
  // here we derive a context from global constants for single-workspace/legacy mode.
  // Requirement 8.5: all dispatched entries must have workspaceId populated.
  const workspaceCtx = getDefaultWorkspaceContext();

  let dirEntries: string[];
  try {
    dirEntries = await import("node:fs/promises").then(fs => fs.readdir(WORKFLOW_DIR));
  } catch {
    return;
  }

  const { lastPollTime: cutoffMs } = await readPollState();
  const pollStart = Date.now();
  const candidates: { name: string; mtime: number }[] = [];

  try {
    const { stat } = await import("node:fs/promises");
    const names = dirEntries.filter(
      (n) => /^[a-f0-9]{32}$/.test(n) && !processedQueues.has(n)
    );
    const results = await Promise.allSettled(
      names.map(async (name) => {
        const s = await stat(path.join(WORKFLOW_DIR, name));
        return { name, mtime: s.mtimeMs };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.mtime >= cutoffMs) {
        candidates.push(r.value);
      }
    }
  } catch (e) {
    console.error(`[queue-poller] stat phase error: ${e}`);
    return;
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const { name } of candidates) {
    const filePath = path.join(WORKFLOW_DIR, name);
    let sayText = "";
    try {
      const raw = await Bun.file(filePath).text();
      const wf = JSON.parse(raw) as {
        actions?: Array<{ actionType: string; output?: { message?: string } }>;
      };
      if (!wf.actions) continue;
      const sayActions = wf.actions.filter(
        (a) => a.actionType === "say" && a.output?.message
      );
      if (sayActions.length === 0) continue;
      sayText = sayActions[sayActions.length - 1].output!.message!;
    } catch {
      continue;
    }

    const hasSignal =
      sayText.includes("CRAWL_QUEUE") ||
      sayText.includes("CLONE_QUEUE") ||
      sayText.includes("PROMPT_QUEUE") ||
      sayText.includes("BUILD_QUEUE");

    if (!hasSignal) continue;

    processedQueues.add(name);

    const utf8 = new TextEncoder();

    // Resolve queue file paths against workspace root for dispatch
    const crawlJobsFilePath = path.isAbsolute(workspaceCtx.crawlJobsFile)
      ? workspaceCtx.crawlJobsFile
      : path.join(workspaceCtx.workspaceRoot, workspaceCtx.crawlJobsFile);
    const cloneJobsFilePath = path.isAbsolute(workspaceCtx.cloneJobsFile)
      ? workspaceCtx.cloneJobsFile
      : path.join(workspaceCtx.workspaceRoot, workspaceCtx.cloneJobsFile);
    const buildQueueFilePath = path.isAbsolute(workspaceCtx.buildQueueFile)
      ? workspaceCtx.buildQueueFile
      : path.join(workspaceCtx.workspaceRoot, workspaceCtx.buildQueueFile);

    // ── CRAWL_QUEUE ─────────────────────────────────────────────────────────
    const crawlMatch = sayText.match(/CRAWL_QUEUE:\s*(\[[\s\S]+?\])/);
    if (crawlMatch) {
      try {
        const parsed = JSON.parse(crawlMatch[1]) as Array<{ url?: string; filepath?: string }>;
        if (parsed.length > 0) {
          const queueFile = crawlJobsFilePath;
          await Bun.write(queueFile, utf8.encode(crawlMatch[1]));
          spawnPythonWorker(CRAWL_WORKER, queueFile, workspaceCtx.workspaceRoot);
          const ts = Date.now();
          appendPollLog({ ts, type: "CRAWL", count: parsed.length, detail: parsed.map(p => p.url ?? "?").join(", "), workflowHash: name });
          const sessions = await scanSessions();
          const sess = sessions.find(s => s.workflowHash === name);
          const dt = new Date(ts);
          const pad = (n: number) => String(n).padStart(2, "0");
          const stem = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}-crawl-${parsed.length}`;
          // Requirement 8.5: populate workspaceId on dispatched record
          await appendBackgroundJobRecord({
            stem, type: "crawl", ts,
            chainId: sess?.chainId ?? "",
            count: parsed.length,
            detail: parsed.map(p => p.url ?? "?").join(", "),
            status: "done",
            workspaceId: workspaceCtx.workspaceId,
          }, crawlJobsFilePath);
          console.log(`[queue-poller] CRAWL_QUEUE: ${parsed.length} page(s) queued (workspace: ${workspaceCtx.workspaceId})`);
        }
      } catch { /* malformed JSON — skip */ }
    }

    // ── CLONE_QUEUE ─────────────────────────────────────────────────────────
    const cloneMatch = sayText.match(/CLONE_QUEUE:\s*(\[[\s\S]+?\])/);
    if (cloneMatch) {
      try {
        const parsed = JSON.parse(cloneMatch[1]) as Array<{ repo?: string; path?: string }>;
        if (parsed.length > 0) {
          const queueFile = cloneJobsFilePath;
          await Bun.write(queueFile, utf8.encode(cloneMatch[1]));
          spawnPythonWorker(CLONE_WORKER, queueFile, workspaceCtx.workspaceRoot);
          const ts = Date.now();
          appendPollLog({ ts, type: "CLONE", count: parsed.length, detail: parsed.map(p => p.repo ?? "?").join(", "), workflowHash: name });
          const sessions = await scanSessions();
          const sess = sessions.find(s => s.workflowHash === name);
          const dt = new Date(ts);
          const pad = (n: number) => String(n).padStart(2, "0");
          const stem = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}-clone-${parsed.length}`;
          // Requirement 8.5: populate workspaceId on dispatched record
          await appendBackgroundJobRecord({
            stem, type: "clone", ts,
            chainId: sess?.chainId ?? "",
            count: parsed.length,
            detail: parsed.map(p => p.repo ?? "?").join(", "),
            status: "done",
            workspaceId: workspaceCtx.workspaceId,
          }, cloneJobsFilePath);
          console.log(`[queue-poller] CLONE_QUEUE: ${parsed.length} repo(s) queued (workspace: ${workspaceCtx.workspaceId})`);
        }
      } catch { /* malformed JSON — skip */ }
    }

    // ── PROMPT_QUEUE ────────────────────────────────────────────────────────
    const promptMatch = sayText.match(/PROMPT_QUEUE:\s*(\[[\s\S]+?\])/);
    if (promptMatch) {
      try {
        const items = JSON.parse(promptMatch[1]) as Array<{ file: string; type?: string }>;
        let dispatched = 0;
        const triggerSessions = await scanSessions();
        const triggerChainId = triggerSessions.find(s => s.workflowHash === name)?.chainId ?? "";
        for (const item of items) {
          let promptFile = item.file;
          if (!path.isAbsolute(promptFile)) {
            // Resolve relative prompt files against workspace root (Req 8.2)
            promptFile = path.join(workspaceCtx.workspaceRoot, promptFile);
          }
          if (!await Bun.file(promptFile).exists()) {
            console.log(`[queue-poller] PROMPT_QUEUE: file not found — ${item.file}`);
            continue;
          }
          const promptType = item.type ?? "analysis";
          const stemBase = path.basename(promptFile, ".md");
          const dt = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const ts = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}`;
          const stem = `${ts}-${stemBase}`;
          console.log(`[queue-poller] PROMPT_QUEUE: dispatching ${path.basename(promptFile)} (${promptType}) (workspace: ${workspaceCtx.workspaceId})`);
          Bun.spawn(
            [
              "powershell.exe", "-ExecutionPolicy", "Bypass",
              "-File", PROMPT_WORKER,
              "-PromptFile", promptFile,
              "-OutputDir", PROMPT_OUTPUT_DIR,
              "-Type", promptType,
              "-Stem", stemBase,
            ],
            // Execute in workspace-specific directory (Req 8.2)
            { cwd: workspaceCtx.workspaceRoot, stdout: "ignore", stderr: "ignore" }
          );
          if (triggerChainId) {
            const sidecarPath = path.join(PROMPT_OUTPUT_DIR, `${stem}.chain`);
            await Bun.write(sidecarPath, triggerChainId);
          }
          dispatched++;
        }
        if (dispatched > 0) {
          appendPollLog({ ts: Date.now(), type: "PROMPT", count: dispatched, detail: items.map(i => path.basename(i.file)).join(", "), workflowHash: name });
        }
      } catch { /* malformed JSON — skip */ }
    }

    // ── BUILD_QUEUE ─────────────────────────────────────────────────────────
    const buildMatch = sayText.match(/BUILD_QUEUE:\s*(\[[\s\S]+?\])/);
    if (buildMatch) {
      try {
        const parsed = JSON.parse(buildMatch[1]) as Array<{ target?: string }>;
        for (const item of parsed) {
          if (item.target !== "dashboard") continue;
          const dt = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const stem = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}-build-${item.target}`;
          const ts = dt.getTime();

          // Requirement 8.5: populate workspaceId on all dispatched BuildQueueRecord entries
          const pendingRecord: BuildQueueRecord = {
            target: "dashboard",
            ts,
            status: "pending",
            stem,
            workspaceId: workspaceCtx.workspaceId,
          };
          const existingBq = await Bun.file(buildQueueFilePath).text().catch(() => "");
          await Bun.write(buildQueueFilePath, existingBq + JSON.stringify(pendingRecord) + "\n");
          console.log(`[queue-poller] BUILD_QUEUE: queued ${stem} (workspace: ${workspaceCtx.workspaceId})`);

          // Execute build in workspace-specific agenthq directory (Req 8.4)
          const swAgentDir = path.join(workspaceCtx.workspaceRoot, "agenthq");
          const buildProc = Bun.spawn(
            ["cmd", "/c", "npm", "run", "build:dashboard"],
            { cwd: swAgentDir, stdout: "ignore", stderr: "ignore" }
          );

          (async () => {
            try {
              const buildingRecord: BuildQueueRecord = {
                target: "dashboard",
                ts,
                status: "building",
                stem,
                workspaceId: workspaceCtx.workspaceId,
              };
              const lines = await Bun.file(buildQueueFilePath).text().catch(() => "");
              const updated = lines
                .split("\n")
                .filter(l => l.trim())
                .map(l => {
                  try {
                    const r = JSON.parse(l) as BuildQueueRecord;
                    return r.stem === stem ? JSON.stringify(buildingRecord) : l;
                  } catch { return l; }
                })
                .join("\n") + "\n";
              await Bun.write(buildQueueFilePath, updated);

              const exitCode = await buildProc.exited;
              const finalRecord: BuildQueueRecord = {
                target: "dashboard",
                ts,
                status: exitCode === 0 ? "done" : "error",
                stem,
                workspaceId: workspaceCtx.workspaceId,
              };
              const lines2 = await Bun.file(buildQueueFilePath).text().catch(() => "");
              const updated2 = lines2
                .split("\n")
                .filter(l => l.trim())
                .map(l => {
                  try {
                    const r = JSON.parse(l) as BuildQueueRecord;
                    return r.stem === stem ? JSON.stringify(finalRecord) : l;
                  } catch { return l; }
                })
                .join("\n") + "\n";
              await Bun.write(buildQueueFilePath, updated2);
              console.log(`[queue-poller] BUILD_QUEUE: ${stem} → ${finalRecord.status} (workspace: ${workspaceCtx.workspaceId})`);
            } catch (e) {
              console.error(`[queue-poller] BUILD_QUEUE status update error: ${e}`);
            }
          })();
        }
      } catch { /* malformed JSON — skip */ }
    }

    break; // one workflow file per poll cycle
  }

  appendPollLog({ ts: pollStart, type: "poll", count: candidates.length, detail: `scanned ${candidates.length} file(s)`, workflowHash: "" });
  await writePollState(pollStart);
}

// ---------------------------------------------------------------------------
// Interval handle — module-level so stopQueuePoller can clear it
// ---------------------------------------------------------------------------

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startQueuePoller(): void {
  _intervalHandle = setInterval(() => {
    pollQueues().catch(err => {
      console.error('[queue-poller] error:', err instanceof Error ? err.stack : err);
    });
  }, 10_000);
}

export function stopQueuePoller(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
