// workers/summariseState.ts
// Persisted in-flight summarise map + auto-mark-summarised loop.
// No import-time side effects — the auto-mark loop is started inside
// loadSummariseState() so that merely importing this module is inert.

import path from "node:path";
import type { SessionState } from "../types.ts";
import { WORKSPACE_ROOT, CHAINS_DIR } from "../constants.ts";
import { scanJobs } from "../scan/jobs.ts";
import { scanChains } from "../scan/chains.ts";
import { scanSessions } from "../scan/sessions.ts";
import { invalidateScanCache } from "../scan/cache.ts";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

export const summariseInFlight = new Map<string, string>(); // chainId -> output stem

const SUMMARISE_STATE_FILE = path.join(WORKSPACE_ROOT, "agenthq", ".summarise-state.json");

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export async function loadSummariseState(): Promise<void> {
  try {
    const raw = await Bun.file(SUMMARISE_STATE_FILE).text();
    const state = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(state)) summariseInFlight.set(k, v);
    console.log(`[summarise-state] loaded ${summariseInFlight.size} in-flight entries`);
  } catch { /* first run or missing — fine */ }

  // Start the auto-mark loop now that state is loaded.
  // Calling loadSummariseState() is the only way to start the loop;
  // importing this module does NOT start it.
  autoMarkSummarisedLoop().catch(() => {});
}

export async function saveSummariseState(): Promise<void> {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of summariseInFlight) obj[k] = v;
    await Bun.write(SUMMARISE_STATE_FILE, JSON.stringify(obj));
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Auto-mark-summarised loop
// ---------------------------------------------------------------------------

async function autoMarkSummarisedLoop(): Promise<void> {
  while (true) {
    try {
      await Bun.sleep(30_000);
      if (summariseInFlight.size === 0) continue;

      const jobs = await scanJobs();
      for (const [chainId, stem] of summariseInFlight) {
        const job = jobs.find(j =>
          j.type === "session-summary" && j.status !== "error" &&
          (j.id.includes(`summarise-${chainId.slice(0, 20).replace(/[^a-z0-9-]/g, "-")}`) ||
           j.id === stem)
        );
        if (job && (job.status === "done" || job.status === "reported")) {
          summariseInFlight.delete(chainId);
          saveSummariseState().catch(() => {});
          // Mark all sessions in this chain as summarised
          try {
            const chains = await scanChains(CHAINS_DIR, await scanSessions());
            const chain = chains.find(c => c.chainId === chainId);
            if (chain) {
              const { readdir, readFile, writeFile } = await import("node:fs/promises");
              const sessionsBase = path.join(WORKSPACE_ROOT, ".kiro", "sessions");
              const dirs = await readdir(sessionsBase).catch(() => [] as string[]);
              const chainDirName = dirs.find(
                d => d.endsWith(`_${chainId}`) && /^\d{4}-\d{2}-\d{2}/.test(d)
              );
              if (chainDirName) {
                const stateDir = path.join(sessionsBase, chainDirName, "State");
                const stateFiles = await readdir(stateDir).catch(() => [] as string[]);
                let updated = 0;
                for (const entry of chain.sessions) {
                  const sf = stateFiles.find(f => f === `${entry.workflowHash}.json`);
                  if (!sf) continue;
                  try {
                    const raw = await readFile(path.join(stateDir, sf), "utf8");
                    const state = JSON.parse(raw) as SessionState;
                    state.lastSummarisedMessageCount = state.messageCount;
                    state.lastSummarisedAt = new Date().toISOString();
                    await writeFile(path.join(stateDir, sf), JSON.stringify(state, null, 2), "utf8");
                    updated++;
                  } catch { /* skip */ }
                }
                console.log(`[auto-mark-summarised] ${chainId}: zeroed delta across ${updated} session(s)`);
                invalidateScanCache();
              }
            }
          } catch (err) {
            console.error(
              "[auto-mark-summarised] error:",
              err instanceof Error ? err.stack : err
            );
            // loop continues — next iteration still executes
          }
        } else if (job && job.status === "error") {
          summariseInFlight.delete(chainId);
          saveSummariseState().catch(() => {});
          console.log(`[auto-mark-summarised] ${chainId}: job errored, not marking summarised`);
        }
      }
    } catch (err) {
      console.error(
        "[auto-mark-summarised] error:",
        err instanceof Error ? err.stack : err
      );
      // loop continues — next iteration still executes
    }
  }
}
