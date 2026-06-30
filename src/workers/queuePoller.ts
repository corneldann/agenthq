// Queue Poller — scans recently modified Kiro workflow files for CRAWL_QUEUE /
// CLONE_QUEUE / PROMPT_QUEUE / BUILD_QUEUE signals and dispatches the
// appropriate workers.  Runs every 10 s via startQueuePoller().
//
// Exports:
//   startQueuePoller  — starts the 10-second interval (call once at startup)
//   stopQueuePoller   — clears the interval (call during graceful shutdown)
//   readPollState     — reads persisted poll state from disk
//   pollLog           — in-memory ring buffer of recent poll events

import path from "node:path";
import type { PollLogEntry, BackgroundJobRecord, BuildQueueRecord } from "../types.ts";
import {
  WORKSPACE_ROOT, WORKFLOW_DIR, CRAWL_JOBS_FILE, CLONE_JOBS_FILE,
  BUILD_QUEUE_FILE, KIRO_TOOLS_DIR, PROMPT_OUTPUT_DIR, POLL_LOG_MAX
} from "../constants.ts";
import { scanSessions } from "../scan/sessions.ts";
import { appendBackgroundJobRecord } from "../scan/jobs.ts";

// ---------------------------------------------------------------------------
// Worker-local configuration constants
// ---------------------------------------------------------------------------

const CRAWL_WORKER  = path.join(KIRO_TOOLS_DIR, "batch_crawl_worker.py");
const CLONE_WORKER  = path.join(KIRO_TOOLS_DIR, "clone_worker.py");
const PROMPT_WORKER = path.join(KIRO_TOOLS_DIR, "sw_agent_worker.ps1");
const PYTHON_PATH   = path.join(KIRO_TOOLS_DIR, ".venv", "Scripts", "python.exe");

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

function spawnPythonWorker(workerScript: string, queueFile: string): void {
  const python = Bun.which("python") ? PYTHON_PATH : "python";
  Bun.spawn([python, workerScript, queueFile], {
    cwd: WORKSPACE_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
}

// ---------------------------------------------------------------------------
// Core poll logic — reads workflow files and dispatches signals
// ---------------------------------------------------------------------------

async function pollQueues(): Promise<void> {
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

    // ── CRAWL_QUEUE ─────────────────────────────────────────────────────────
    const crawlMatch = sayText.match(/CRAWL_QUEUE:\s*(\[[\s\S]+?\])/);
    if (crawlMatch) {
      try {
        const parsed = JSON.parse(crawlMatch[1]) as Array<{ url?: string; filepath?: string }>;
        if (parsed.length > 0) {
          const queueFile = path.join(WORKSPACE_ROOT, "docs", "reference", ".crawl-queue.json");
          await Bun.write(queueFile, utf8.encode(crawlMatch[1]));
          spawnPythonWorker(CRAWL_WORKER, queueFile);
          const ts = Date.now();
          appendPollLog({ ts, type: "CRAWL", count: parsed.length, detail: parsed.map(p => p.url ?? "?").join(", "), workflowHash: name });
          const sessions = await scanSessions();
          const sess = sessions.find(s => s.workflowHash === name);
          const dt = new Date(ts);
          const pad = (n: number) => String(n).padStart(2, "0");
          const stem = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}-crawl-${parsed.length}`;
          await appendBackgroundJobRecord({
            stem, type: "crawl", ts,
            chainId: sess?.chainId ?? "",
            count: parsed.length,
            detail: parsed.map(p => p.url ?? "?").join(", "),
            status: "done",
          }, CRAWL_JOBS_FILE);
          console.log(`[queue-poller] CRAWL_QUEUE: ${parsed.length} page(s) queued`);
        }
      } catch { /* malformed JSON — skip */ }
    }

    // ── CLONE_QUEUE ─────────────────────────────────────────────────────────
    const cloneMatch = sayText.match(/CLONE_QUEUE:\s*(\[[\s\S]+?\])/);
    if (cloneMatch) {
      try {
        const parsed = JSON.parse(cloneMatch[1]) as Array<{ repo?: string; path?: string }>;
        if (parsed.length > 0) {
          const queueFile = path.join(WORKSPACE_ROOT, "docs", "reference", ".clone-queue.json");
          await Bun.write(queueFile, utf8.encode(cloneMatch[1]));
          spawnPythonWorker(CLONE_WORKER, queueFile);
          const ts = Date.now();
          appendPollLog({ ts, type: "CLONE", count: parsed.length, detail: parsed.map(p => p.repo ?? "?").join(", "), workflowHash: name });
          const sessions = await scanSessions();
          const sess = sessions.find(s => s.workflowHash === name);
          const dt = new Date(ts);
          const pad = (n: number) => String(n).padStart(2, "0");
          const stem = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}-clone-${parsed.length}`;
          await appendBackgroundJobRecord({
            stem, type: "clone", ts,
            chainId: sess?.chainId ?? "",
            count: parsed.length,
            detail: parsed.map(p => p.repo ?? "?").join(", "),
            status: "done",
          }, CLONE_JOBS_FILE);
          console.log(`[queue-poller] CLONE_QUEUE: ${parsed.length} repo(s) queued`);
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
            promptFile = path.join(WORKSPACE_ROOT, promptFile);
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
          console.log(`[queue-poller] PROMPT_QUEUE: dispatching ${path.basename(promptFile)} (${promptType})`);
          Bun.spawn(
            [
              "powershell.exe", "-ExecutionPolicy", "Bypass",
              "-File", PROMPT_WORKER,
              "-PromptFile", promptFile,
              "-OutputDir", PROMPT_OUTPUT_DIR,
              "-Type", promptType,
              "-Stem", stemBase,
            ],
            { cwd: WORKSPACE_ROOT, stdout: "ignore", stderr: "ignore" }
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

          const pendingRecord: BuildQueueRecord = { target: "dashboard", ts, status: "pending", stem };
          const existingBq = await Bun.file(BUILD_QUEUE_FILE).text().catch(() => "");
          await Bun.write(BUILD_QUEUE_FILE, existingBq + JSON.stringify(pendingRecord) + "\n");
          console.log(`[queue-poller] BUILD_QUEUE: queued ${stem}`);

          const swAgentDir = path.join(WORKSPACE_ROOT, "agenthq");
          const buildProc = Bun.spawn(
            ["cmd", "/c", "npm", "run", "build:dashboard"],
            { cwd: swAgentDir, stdout: "ignore", stderr: "ignore" }
          );

          (async () => {
            try {
              const buildingRecord: BuildQueueRecord = { target: "dashboard", ts, status: "building", stem };
              const lines = await Bun.file(BUILD_QUEUE_FILE).text().catch(() => "");
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
              await Bun.write(BUILD_QUEUE_FILE, updated);

              const exitCode = await buildProc.exited;
              const finalRecord: BuildQueueRecord = {
                target: "dashboard",
                ts,
                status: exitCode === 0 ? "done" : "error",
                stem,
              };
              const lines2 = await Bun.file(BUILD_QUEUE_FILE).text().catch(() => "");
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
              await Bun.write(BUILD_QUEUE_FILE, updated2);
              console.log(`[queue-poller] BUILD_QUEUE: ${stem} → ${finalRecord.status}`);
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
