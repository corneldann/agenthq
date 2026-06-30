// src/routes/build.ts
// Route handlers for build operations: GET /build-status, GET /build-stream

import path from 'node:path';
import type { Router } from '../router.ts';
import { WORKSPACE_ROOT } from '../constants.ts';

export function register(router: Router): void {
  // GET /build-status — compare src mtime vs dist mtime to detect stale build
  router.get('/build-status', async (_req, _params) => {
    try {
      const swAgentDir = path.join(WORKSPACE_ROOT, 'agenthq');
      const distFile = path.join(swAgentDir, 'dist', 'dashboard.html');
      const distMtime = Bun.file(distFile).lastModified ?? 0;
      const glob = new Bun.Glob('src/dashboard/**/*.{ts,html,css}');
      const staleFiles: string[] = [];
      for await (const rel of glob.scan(swAgentDir)) {
        const mtime = Bun.file(path.join(swAgentDir, rel)).lastModified ?? 0;
        if (mtime > distMtime) staleFiles.push(rel.replace(/\\/g, '/'));
      }
      const distDate = distMtime > 0
        ? new Date(distMtime).toISOString().slice(0, 16).replace('T', ' ')
        : null;
      return new Response(
        JSON.stringify({ stale: staleFiles.length > 0, staleFiles, distBuiltAt: distDate }),
        { headers: { 'content-type': 'application/json', 'connection': 'close' } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err) }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  // GET /build-stream — SSE stream for live `npm run build:dashboard` output
  router.get('/build-stream', (_req, _params) => {
    const swAgentDir = path.join(WORKSPACE_ROOT, 'agenthq');
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        function send(data: string): void {
          try {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch {
            // client disconnected — ignore
          }
        }

        try {
          const proc = Bun.spawn(
            ['npm.cmd', 'run', 'build:dashboard'],
            { cwd: swAgentDir, stdout: 'pipe', stderr: 'pipe' }
          );

          // Stream stdout
          const stdoutReader = proc.stdout.getReader();
          const stderrReader = proc.stderr.getReader();
          const decoder = new TextDecoder();

          // Interleave stdout and stderr by reading both concurrently
          async function drainReader(
            reader: ReadableStreamDefaultReader<Uint8Array>
          ): Promise<void> {
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() ?? '';
              for (const line of lines) {
                send(line);
              }
            }
            if (buf.length > 0) send(buf);
          }

          await Promise.all([drainReader(stdoutReader), drainReader(stderrReader)]);
          const exitCode = await proc.exited;
          send(JSON.stringify({ done: true, exitCode }));
        } catch (err) {
          send(JSON.stringify({ done: true, exitCode: 1, error: String(err) }));
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
    });
  });
}
