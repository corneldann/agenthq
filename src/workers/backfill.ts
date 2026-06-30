// ---------------------------------------------------------------------------
// backfill.ts — one-shot startup backfill for prompt sidecars and background
// job records. Extracted from monitor.ts. No import-time side effects.
// Call runBackfill() explicitly to trigger backfill.
// ---------------------------------------------------------------------------

import path from "node:path";
import type { BackgroundJobRecord } from "../types.ts";
import {
  WORKSPACE_ROOT,
  WORKFLOW_DIR,
  CRAWL_JOBS_FILE,
  CLONE_JOBS_FILE,
  PROMPT_OUTPUT_DIR,
} from "../constants.ts";
import { scanSessions } from "../scan/sessions.ts";

// ---------------------------------------------------------------------------
// backfillPromptSidecars — scans ALL workflow files for PROMPT_QUEUE say
// signals and writes .chain sidecar files next to matching output .md files.
// Runs unconditionally on every startup.
// ---------------------------------------------------------------------------

async function backfillPromptSidecars(): Promise<void> {
  // Build workflowHash → chainId map from sessions
  const sessions = await scanSessions();
  const hashToChain = new Map<string, string>(
    sessions.map(s => [s.workflowHash, s.chainId])
  );

  let dirEntries: string[];
  try {
    dirEntries = await import("node:fs/promises").then(fs => fs.readdir(WORKFLOW_DIR));
  } catch {
    return;
  }

  const names = dirEntries.filter(n => /^[a-f0-9]{32}$/.test(n));
  let written = 0;

  await Promise.all(names.map(async (name) => {
    try {
      const raw = await Bun.file(path.join(WORKFLOW_DIR, name)).text();
      const wf = JSON.parse(raw) as {
        actions?: Array<{ actionType: string; output?: { message?: string } }>;
      };
      if (!wf.actions) return;

      const sayActions = wf.actions.filter(
        a => a.actionType === "say" && a.output?.message
      );
      if (sayActions.length === 0) return;
      const sayText = sayActions[sayActions.length - 1].output!.message!;
      if (!sayText.includes("PROMPT_QUEUE")) return;

      const chainId = hashToChain.get(name) ?? "";
      if (!chainId) return;

      const promptMatch = sayText.match(/PROMPT_QUEUE:\s*(\[[\s\S]+?\])/);
      if (!promptMatch) return;

      try {
        const items = JSON.parse(promptMatch[1]) as Array<{ file?: string }>;
        for (const item of items) {
          if (!item.file) continue;
          const stemBase = path.basename(item.file, ".md");
          // Skip if a sidecar already exists for this stem
          const existingGlob = new Bun.Glob(`*${stemBase}.chain`);
          const existing = await Array.fromAsync(existingGlob.scan(PROMPT_OUTPUT_DIR));
          if (existing.length > 0) continue;
          // Find matching output .md and write sidecar alongside it
          const mdGlob = new Bun.Glob(`*${stemBase}.md`);
          const mdFiles = await Array.fromAsync(mdGlob.scan(PROMPT_OUTPUT_DIR));
          for (const mdFile of mdFiles) {
            const sidecarName = mdFile.replace(/\.md$/, ".chain");
            await Bun.write(path.join(PROMPT_OUTPUT_DIR, sidecarName), chainId);
            written++;
          }
        }
      } catch { /* malformed PROMPT_QUEUE — skip */ }
    } catch { /* skip unreadable workflow files */ }
  }));

  if (written > 0) {
    console.log(`[backfill-prompt] wrote ${written} .chain sidecar(s)`);
  }
}

// ---------------------------------------------------------------------------
// backfillBackgroundJobs — backfills crawl/clone NDJSON sidecar records from
// existing workflow files. Only runs if CRAWL_JOBS_FILE or CLONE_JOBS_FILE
// don't exist yet.
// ---------------------------------------------------------------------------

async function backfillBackgroundJobs(): Promise<void> {
  // Guard: only backfill if at least one sidecar file is missing
  const crawlExists = await Bun.file(CRAWL_JOBS_FILE).exists();
  const cloneExists = await Bun.file(CLONE_JOBS_FILE).exists();
  if (crawlExists && cloneExists) return;

  // Build workflowHash → chainId map from sessions
  const sessions = await scanSessions();
  const hashToChain = new Map<string, string>(
    sessions.map(s => [s.workflowHash, s.chainId])
  );

  let dirEntries: string[];
  try {
    dirEntries = await import("node:fs/promises").then(fs => fs.readdir(WORKFLOW_DIR));
  } catch {
    return;
  }

  const { stat } = await import("node:fs/promises");
  const names = dirEntries.filter(n => /^[a-f0-9]{32}$/.test(n));

  const crawlRecords: BackgroundJobRecord[] = [];
  const cloneRecords: BackgroundJobRecord[] = [];

  await Promise.all(names.map(async (name) => {
    try {
      const raw = await Bun.file(path.join(WORKFLOW_DIR, name)).text();
      const wf = JSON.parse(raw) as {
        actions?: Array<{ actionType: string; output?: { message?: string } }>;
      };
      if (!wf.actions) return;

      const sayActions = wf.actions.filter(
        a => a.actionType === "say" && a.output?.message
      );
      if (sayActions.length === 0) return;
      const sayText = sayActions[sayActions.length - 1].output!.message!;

      const hasCrawl = sayText.includes("CRAWL_QUEUE");
      const hasClone = sayText.includes("CLONE_QUEUE");
      if (!hasCrawl && !hasClone) return;

      // Use file mtime as dispatch timestamp
      const s = await stat(path.join(WORKFLOW_DIR, name));
      const ts = s.mtimeMs;
      const chainId = hashToChain.get(name) ?? "";

      const dt = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, "0");
      const datePrefix = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}`;

      if (hasCrawl) {
        const crawlMatch = sayText.match(/CRAWL_QUEUE:\s*(\[[\s\S]+?\])/);
        if (crawlMatch) {
          try {
            const parsed = JSON.parse(crawlMatch[1]) as Array<{ url?: string }>;
            if (parsed.length > 0) {
              crawlRecords.push({
                stem: `${datePrefix}-crawl-${parsed.length}`,
                type: "crawl",
                ts,
                chainId,
                count: parsed.length,
                detail:
                  parsed.map(p => p.url ?? "?").slice(0, 5).join(", ") +
                  (parsed.length > 5 ? ` +${parsed.length - 5} more` : ""),
                status: "done",
              });
            }
          } catch { /* malformed CRAWL_QUEUE */ }
        }
      }

      if (hasClone) {
        const cloneMatch = sayText.match(/CLONE_QUEUE:\s*(\[[\s\S]+?\])/);
        if (cloneMatch) {
          try {
            const parsed = JSON.parse(cloneMatch[1]) as Array<{ repo?: string }>;
            if (parsed.length > 0) {
              cloneRecords.push({
                stem: `${datePrefix}-clone-${parsed.length}`,
                type: "clone",
                ts,
                chainId,
                count: parsed.length,
                detail:
                  parsed.map(p => p.repo ?? "?").slice(0, 5).join(", ") +
                  (parsed.length > 5 ? ` +${parsed.length - 5} more` : ""),
                status: "done",
              });
            }
          } catch { /* malformed CLONE_QUEUE */ }
        }
      }
    } catch { /* skip unreadable workflow files */ }
  }));

  // Deduplicate by stem, sort newest first, then write
  const dedup = <T extends { stem: string }>(arr: T[]): T[] => {
    const seen = new Set<string>();
    return arr.filter(r => (seen.has(r.stem) ? false : (seen.add(r.stem), true)));
  };

  if (!crawlExists && crawlRecords.length > 0) {
    const sorted = dedup(crawlRecords.sort((a, b) => b.ts - a.ts));
    await Bun.write(
      CRAWL_JOBS_FILE,
      sorted.map(r => JSON.stringify(r)).join("\n") + "\n"
    );
    console.log(`[backfill] crawl: ${sorted.length} record(s) written from workflow files`);
  }

  if (!cloneExists && cloneRecords.length > 0) {
    const sorted = dedup(cloneRecords.sort((a, b) => b.ts - a.ts));
    await Bun.write(
      CLONE_JOBS_FILE,
      sorted.map(r => JSON.stringify(r)).join("\n") + "\n"
    );
    console.log(`[backfill] clone: ${sorted.length} record(s) written from workflow files`);
  }
}

// ---------------------------------------------------------------------------
// runBackfill — public entry point. Calls both backfill functions in sequence.
// Never rejects — errors are logged with [backfill] prefix.
// ---------------------------------------------------------------------------

export async function runBackfill(): Promise<void> {
  try {
    await backfillPromptSidecars();
    await backfillBackgroundJobs();
  } catch (err) {
    console.error("[backfill] error:", err instanceof Error ? err.stack : err);
    // does not rethrow
  }
}
