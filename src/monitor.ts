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

// ========== Phase 5.1: DB Layer Imports ==========
import { loadDbConfig } from './config/db-config.ts';
import { createDbAdapter } from './db/adapter.ts';
import { runMigrations } from './db/migrations.ts';
import { startFileWatcher } from './workers/fileWatcher.ts';
import { register as registerStatusHistory } from './routes/status-history.ts';

const DIST_DIR = path.resolve(import.meta.dir, '../dist');
const FLAT_ASSET_RE = /^\/(index-[a-z0-9]+\.(js|css))$/;
const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../migrations');

// ========== Phase 5.1: DB Configuration (Req 7.1-7.5, 8.4) ==========
// Load and validate DB config early — abort on misconfiguration before serving.
let dbConfig: ReturnType<typeof loadDbConfig>;
try {
  dbConfig = loadDbConfig(process.env as Record<string, string | undefined>);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Configuration error: ${msg}`);
  process.exit(1);
}

/**
 * Whether the database has finished initialising (migrations complete).
 * Flips from false → true exactly once, just before Bun.serve() is called.
 * When DB_ENABLED=false this is never used — it stays false but middleware
 * skips the check entirely.
 *
 * Exported so tests and middleware can inspect it directly.
 */
export let dbReady: boolean = false;

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

// ========== Phase 5.1: DB Startup Gating (Req 5.6, 8.3, 8.4, 9.1) ==========
// Run migrations synchronously before opening the HTTP server so that
// dbReady=true is guaranteed before the first request is dispatched.
let dbAdapter: ReturnType<typeof createDbAdapter> | null = null;
if (dbConfig.enabled) {
  try {
    dbAdapter = createDbAdapter(dbConfig);
    await runMigrations(dbAdapter, MIGRATIONS_DIR);
    dbReady = true;
    // Register DB-backed routes only when the DB is available (Req 8.4)
    registerStatusHistory(router, dbAdapter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Database initialisation failed: ${msg}`);
    process.exit(1);
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    if (_shuttingDown) return new Response('Service Unavailable', { status: 503 });
    _inFlight++;
    try {
      // ===== Task 22: DB-init gate middleware (Req 8.4) ====================
      // While the database is still initialising (dbReady=false AND
      // DB_ENABLED=true), block all /api/ routes with 503 so callers
      // never receive stale or partially-populated data.
      //
      // Routes that source data from file scanners (/jobs, /chains, /sessions,
      // static assets, and /) bypass this gate — they work without the DB.
      //
      // Once dbReady=true this block is never entered (fast path).
      // When DB_ENABLED=false the check is skipped entirely.
      const { pathname } = new URL(req.url);

      if (!dbReady && dbConfig.enabled) {
        if (pathname.startsWith('/api/')) {
          return new Response(
            JSON.stringify({ error: 'initializing' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          );
        }
      }

      const match = router.match(req);
      if (match) return await match.handler(req, match.params);

      // Static asset fallback: flat index-*.js|css files emitted by Vite build
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

// ========== Phase 5.1: File Watcher (Req 2.1, 6.6) ==========
// Start after Bun.serve() so the watcher does not block HTTP startup.
// Only runs when the DB is enabled and successfully initialised.
if (dbConfig.enabled && dbAdapter !== null) {
  startFileWatcher(dbAdapter, OUTPUT_DIR);
}
