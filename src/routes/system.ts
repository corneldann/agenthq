// src/routes/system.ts
// Route handlers for system management: GET /system-status, POST /stop,
// POST /shutdown, POST /restart

import type { Router } from '../router.ts';
import { WORKFLOW_DIR } from '../constants.ts';
import { sseClients, stopSSEBroadcaster } from '../workers/ssebroadcaster.ts';
import { summariseInFlight } from '../workers/summariseState.ts';
import { pollLog, readPollState, stopQueuePoller } from '../workers/queuePoller.ts';

export function register(router: Router): void {
  // GET /system-status — live monitor health snapshot
  router.get('/system-status', async (_req, _params) => {
    const lastPoll = pollLog.filter(e => e.type === 'poll').at(-1);
    const pollState = await readPollState().catch(() => ({
      lastPollTime: 0,
      processed: [] as string[],
    }));
    return new Response(
      JSON.stringify({
        sseClients: sseClients.size,
        summariseInFlight: summariseInFlight.size,
        processedCount: pollState.processed.length,
        lastPollTime: pollState.lastPollTime,
        lastPollAgo: lastPoll ? Date.now() - lastPoll.ts : null,
        uptime: process.uptime(),
        workflowDirOk: await import('node:fs/promises').then(fs =>
          fs.access(WORKFLOW_DIR).then(() => true, () => false)
        ),
      }),
      { headers: { 'content-type': 'application/json', 'connection': 'close' } }
    );
  });

  // POST /shutdown — graceful shutdown: stop workers, close SSE clients, exit
  router.post('/shutdown', async (_req, _params) => {
    stopSSEBroadcaster();
    stopQueuePoller();
    for (const client of sseClients) {
      try { client.enqueue('data: shutdown\n\n'); } catch { /* ignore */ }
    }
    sseClients.clear();
    setTimeout(() => process.exit(0), 100);
    return new Response('Shutting down\u2026', {
      headers: { 'content-type': 'text/plain' },
    });
  });

  // POST /stop — alias for /shutdown: stop workers, close SSE clients, exit
  router.post('/stop', (_req, _params) => {
    stopSSEBroadcaster();
    stopQueuePoller();
    for (const client of sseClients) {
      try { client.enqueue('data: shutdown\n\n'); } catch { /* ignore */ }
    }
    sseClients.clear();
    setTimeout(() => process.exit(0), 100);
    return new Response('Stopping…', {
      headers: { 'content-type': 'text/plain' },
    });
  });

  // POST /restart — spawn fresh process then exit current one
  router.post('/restart', (_req, _params) => {
    stopSSEBroadcaster();
    stopQueuePoller();
    for (const client of sseClients) {
      try { client.enqueue('data: shutdown\n\n'); } catch { /* ignore */ }
    }
    sseClients.clear();
    setTimeout(() => {
      Bun.spawn([process.execPath, ...process.argv.slice(1)]);
      process.exit(0);
    }, 200);
    return new Response('Restarting…', {
      headers: { 'content-type': 'text/plain' },
    });
  });
}
