// scan/jobs.ts
// Job scanning functions extracted from monitor.ts.
// No import-time side effects — no setInterval, no Bun.serve, no top-level I/O.

import type { Job, BackgroundJobRecord, BuildQueueRecord } from '../types.ts';
import {
  OUTPUT_DIR,
  CRAWL_JOBS_FILE,
  CLONE_JOBS_FILE,
  BUILD_QUEUE_FILE,
} from '../constants.ts';
import {
  extractName,
  detectStatus,
  parseTimestamp,
  extractHeader,
  extractAgentDone,
  extractSessionChainId,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// Crawl/Clone job sidecar — written at dispatch time, read by scanJobs()
// ---------------------------------------------------------------------------

export async function appendBackgroundJobRecord(
  record: BackgroundJobRecord,
  file: string
): Promise<void> {
  try {
    const line = JSON.stringify(record) + "\n";
    const existing = await Bun.file(file).text().catch(() => "");
    await Bun.write(file, existing + line);
  } catch { /* best-effort */ }
}

export async function readBackgroundJobRecords(
  file: string
): Promise<BackgroundJobRecord[]> {
  try {
    const text = await Bun.file(file).text();
    return text
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as BackgroundJobRecord)
      .filter(r => r && r.stem);
  } catch {
    return [];
  }
}

export async function scanJobs(
  outputDir: string = OUTPUT_DIR,
  workspaceId: string = "default"
): Promise<Job[]> {
  const filenames: string[] = await Array.fromAsync(
    new Bun.Glob("*.md").scan(outputDir)
  );
  if (filenames.length === 0) return [];

  const promptJobs = await Promise.all(
    filenames.map(async (filename: string) => {
      const id = filename.replace(/\.md$/, "");
      const name = extractName(filename);
      const timestamp = parseTimestamp(filename);
      const mdPath = `${outputDir}/${filename}`;
      const logPath = `${outputDir}/${filename.replace(/\.md$/, ".log")}`;

      const mdFile = Bun.file(mdPath);
      const sizeBytes = mdFile.size;
      const mdContent = await mdFile.text();
      const lines = mdContent.split("\n").length;

      const nonEmpty = mdContent
        .split("\n")
        .filter((l: string) => l.trim().length > 0);
      const lastLineRaw = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : "";
      const lastLine =
        lastLineRaw.length > 120
          ? lastLineRaw.slice(0, 120) + "…"
          : lastLineRaw;

      const type = extractHeader(mdContent, "type");
      const agent = extractHeader(mdContent, "agent");
      const source = extractHeader(mdContent, "source");

      let logContent: string | null = null;
      let hasLog = false;
      let logError = false;
      const logFile = Bun.file(logPath);
      if (await logFile.exists()) {
        hasLog = true;
        logContent = await logFile.text();
        logError =
          logContent.includes("Error:") ||
          logContent.includes("Response failed") ||
          /exit code [^0]/.test(logContent);
      }

      const status = detectStatus(mdContent, logContent, agent);
      const agentDone = extractAgentDone(mdContent);

      // Resolve sessionChainId: check .chain sidecar first, fall back to source header
      const sidecarPath = `${outputDir}/${filename.replace(/\.md$/, ".chain")}`;
      const sidecarFile = Bun.file(sidecarPath);
      const sidecarChainId = await sidecarFile.exists()
        ? (await sidecarFile.text()).trim()
        : "";
      const sessionChainId = sidecarChainId || extractSessionChainId(source);

      return {
        id,
        name,
        jobChain: name,
        sessionChainId: sessionChainId,
        timestamp,
        type,
        agent,
        status,
        lines,
        lastLine,
        hasLog,
        logError,
        mdFile: filename,
        logFile: filename.replace(/\.md$/, ".log"),
        agentDone,
        sizeBytes,
        workspaceId,
      } satisfies Job;
    })
  );

  // ── Synthetic crawl/clone jobs from sidecar files ────────────────────────
  const [crawlRecords, cloneRecords] = await Promise.all([
    readBackgroundJobRecords(CRAWL_JOBS_FILE),
    readBackgroundJobRecords(CLONE_JOBS_FILE),
  ]);

  // ── Synthetic build jobs from build queue file ────────────────────────────
  let buildRecords: BuildQueueRecord[] = [];
  try {
    const bqText = await Bun.file(BUILD_QUEUE_FILE).text().catch(() => "");
    buildRecords = bqText
      .split("\n")
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) as BuildQueueRecord; } catch { return null; } })
      .filter((r): r is BuildQueueRecord => r !== null && !!r.stem);
  } catch { /* no build queue yet */ }

  const buildJobs: Job[] = buildRecords.map(r => {
    const dt = new Date(r.ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    const jobStatus: Job["status"] =
      r.status === "done" ? "done" :
      r.status === "error" ? "error" : "running";
    return {
      id:             r.stem,
      name:           `build-${r.target}`,
      jobChain:       `build-${r.target}`,
      sessionChainId: "",
      timestamp,
      type:           "build",
      agent:          "bun-spawn",
      status:         jobStatus,
      lines:          0,
      lastLine:       r.status,
      hasLog:         false,
      logError:       r.status === "error",
      mdFile:         "",
      logFile:        "",
      agentDone:      "",
      sizeBytes:      0,
      workspaceId,
    } satisfies Job;
  });

  const bgJobs: Job[] = [...crawlRecords, ...cloneRecords].map(r => {
    const dt = new Date(r.ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    const label = r.type === "crawl"
      ? `crawl-${r.count}-page${r.count !== 1 ? "s" : ""}`
      : `clone-${r.count}-repo${r.count !== 1 ? "s" : ""}`;
    return {
      id:             r.stem,
      name:           label,
      jobChain:       r.type === "crawl" ? "crawl" : "clone",
      sessionChainId: r.chainId,
      timestamp,
      type:           r.type,
      agent:          "python-worker",
      status:         r.status,
      lines:          r.count,
      lastLine:       r.detail.length > 120 ? r.detail.slice(0, 120) + "…" : r.detail,
      hasLog:         false,
      logError:       r.status === "error",
      mdFile:         "",
      logFile:        "",
      agentDone:      "",
      sizeBytes:      0,
      workspaceId,
    } satisfies Job;
  });

  const jobs = [...promptJobs, ...bgJobs, ...buildJobs];
  return jobs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
