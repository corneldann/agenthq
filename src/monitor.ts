import path from 'node:path';
import { existsSync } from 'node:fs';
import { KIRO_TOOLS_DIR, PORT, WORKSPACE_ROOT, SHUTDOWN_TIMEOUT_MS, OUTPUT_DIR, SESSIONS_DIR, WORKFLOW_DIR } from './constants.ts';
import { findUnconfiguredVars, validateEnvPaths } from './validation.ts';
import { createRouter } from './router.ts';

// ========== Phase 4: Startup Validation (Req 4.1-4.5, 5.5) ==========
// Validate environment configuration before accepting connections
const unconfigured = findUnconfiguredVars({
  OUTPUT_DIR,
  SESSIONS_DIR,
  WORKSPACE_ROOT,
});

const invalidPaths = validateEnvPaths({
  OUTPUT_DIR,
  SESSIONS_DIR,
  WORKSPACE_ROOT,
}, existsSync);

// Check for unexpanded environment variables in WORKFLOW_DIR (% syntax on Windows)
const hasUnexpandedVar = WORKFLOW_DIR.includes('%');

let hasErrors = false;

// Emit WARNING for each unconfigured variable (Req 4.1, 4.2, 4.3, 4.4)
if (unconfigured.length > 0) {
  for (const varName of unconfigured) {
    console.warn(`WARNING: Required environment variable ${varName} is not configured`);
  }
  hasErrors = true;
}

// Emit WARNING for each invalid path (Req 5.5)
if (invalidPaths.length > 0) {
  for (const varName of invalidPaths) {
    const envValue = varName === 'OUTPUT_DIR' ? OUTPUT_DIR : 
                     varName === 'SESSIONS_DIR' ? SESSIONS_DIR : 
                     WORKSPACE_ROOT;
    console.warn(`WARNING: Path for ${varName} does not exist: ${envValue}`);
  }
  hasErrors = true;
}

// Check WORKFLOW_DIR for unexpanded environment variables
if (hasUnexpandedVar) {
  console.warn(`WARNING: WORKFLOW_DIR contains unexpanded environment variable: ${WORKFLOW_DIR}`);
  hasErrors = true;
}

// Exit with non-zero code if any validation failed (Req 4.4, 4.5)
if (hasErrors) {
  console.error('Monitor startup validation failed. Please fix the above issues in your .env file.');
  process.exit(1);
}

// ========== Worker Imports (after validation guard) ==========
import { startSSEBroadcaster } from './workers/ssebroadcaster.ts';
import { runBackfill } from './workers/backfill.ts';
import { startQueuePoller } from './workers/queuePoller.ts';
import { loadSummariseState } from './workers/summariseState.ts';
import { register as registerChains }          from './routes/chains.ts';
import { register as registerJobs }            from './routes/jobs.ts';
import { register as registerSummarise }       from './routes/summarise.ts';
import { register as registerResume }          from './routes/resume.ts';
import { register as registerGit }            from './routes/git.ts';
import { register as registerBuild }          from './routes/build.ts';
import { register as registerChainManagement } from './routes/chain-management.ts';
import { register as registerSystem }         from './routes/system.ts';
import { register as registerSSE }            from './routes/sse.ts';
import { register as registerStatic }         from './routes/static.ts';

const DIST_DIR = path.resolve(import.meta.dir, '../dist');
const FLAT_ASSET_RE = /^\/(index-[a-z0-9]+\.(js|css))$/;

// Run session-state-manager once at startup so /chains is populated immediately
Bun.spawn(
  ['powershell.exe', '-ExecutionPolicy', 'Bypass', '-File', path.join(KIRO_TOOLS_DIR, 'session-state-manager.ps1')],
  { cwd: WORKSPACE_ROOT, stderr: 'ignore', stdout: 'ignore' }
);

// 60s session state poller — runs session-state-manager.ps1 to refresh .kiro/sessions/*.json
setInterval(() => {
  Bun.spawn(
    ['powershell.exe', '-ExecutionPolicy', 'Bypass', '-File', path.join(KIRO_TOOLS_DIR, 'session-state-manager.ps1')],
    { cwd: WORKSPACE_ROOT, stderr: 'ignore', stdout: 'ignore' }
  );
}, 60_000);

const router = createRouter();
registerChains(router);
registerJobs(router);
registerSummarise(router);
registerResume(router);
registerGit(router);
registerBuild(router);
registerChainManagement(router);
registerSystem(router);
registerSSE(router);
registerStatic(router);

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    if (_shuttingDown) return new Response('Service Unavailable', { status: 503 });
    _inFlight++;
    try {
      const match = router.match(req);
      if (match) return await match.handler(req, match.params);

      // Static asset fallback: flat index-*.js|css files emitted by Vite build
      const { pathname } = new URL(req.url);
      const flatMatch = FLAT_ASSET_RE.exec(pathname);
      if (flatMatch) {
        const file = Bun.file(path.join(DIST_DIR, flatMatch[1]));
        if (await file.exists()) {
          const ct = flatMatch[2] === 'css' ? 'text/css' : 'application/javascript';
          return new Response(file, { headers: { 'content-type': ct } });
        }
      }
      // /dist/<file> path variant
      if (pathname.startsWith('/dist/')) {
        const filename = pathname.slice(6); // strip "/dist/"
        const file = Bun.file(path.join(DIST_DIR, filename));
        if (await file.exists()) {
          const ct = filename.endsWith('.css') ? 'text/css' : 'application/javascript';
          return new Response(file, { headers: { 'content-type': ct } });
        }
      }

      return new Response('Not found', { status: 404 });
    } finally {
      _inFlight--;
      _drainResolve?.();
    }
  },
});

export let _inFlight = 0;
export let _shuttingDown = false;
export let _drainResolve: (() => void) | null = null;

export async function waitForDrain(): Promise<void> {
  if (_inFlight === 0) return;
  const timeout = new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
  const drain   = new Promise<void>(resolve => { _drainResolve = resolve; });
  await Promise.race([drain, timeout]);
}

console.log(`Monitor server running on http://localhost:${server.port}`);

startSSEBroadcaster();
await loadSummariseState();
await runBackfill();
startQueuePoller();
