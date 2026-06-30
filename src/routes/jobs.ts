// routes/jobs.ts — Job list, log file, and build-queue route handlers.

import type { Router } from '../router.ts';
import type { BuildQueueRecord } from '../types.ts';
import { OUTPUT_DIR, BUILD_QUEUE_FILE } from '../constants.ts';
import { scanJobs } from '../scan/jobs.ts';

export function register(router: Router): void {
  // ------------------------------------------------------------------
  // GET /jobs — full list of Job objects from OUTPUT_DIR
  // ------------------------------------------------------------------
  router.get('/jobs', async (_req, _params) => {
    const jobs = await scanJobs();
    return new Response(JSON.stringify(jobs), {
      headers: { "content-type": "application/json", "connection": "close" },
    });
  });

  // ------------------------------------------------------------------
  // GET /log/:id — raw .log file content for a given job stem
  // ------------------------------------------------------------------
  router.get('/log/:id', async (_req, params) => {
    const id = decodeURIComponent(params.id);
    const logPath = `${OUTPUT_DIR}/${id}.log`;
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    const text = await file.text();
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  // ------------------------------------------------------------------
  // GET /build-queue — parsed records from BUILD_QUEUE_FILE
  // ------------------------------------------------------------------
  router.get('/build-queue', async (_req, _params) => {
    try {
      const text = await Bun.file(BUILD_QUEUE_FILE).text().catch(() => "");
      const records: BuildQueueRecord[] = text
        .split("\n")
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l) as BuildQueueRecord; } catch { return null; }
        })
        .filter((r): r is BuildQueueRecord => r !== null && !!r.stem);
      return new Response(JSON.stringify(records), {
        headers: { "content-type": "application/json", "connection": "close" },
      });
    } catch {
      return new Response("[]", {
        headers: { "content-type": "application/json", "connection": "close" },
      });
    }
  });
}
