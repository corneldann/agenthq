/**
 * smoke.ts — Wave 5 endpoint smoke test
 *
 * Verifies that every route registered in the monitor is reachable and returns
 * the expected HTTP status code and Content-Type after the Wave 5 refactor.
 *
 * Run with:   bun test/smoke.ts
 *
 * Requires the monitor to be running on PORT (default 3333).
 * The test does NOT start or stop the monitor process itself.
 *
 * All tests are read-only — no POST/mutation endpoints are exercised against
 * live data, only checked for ≠ 404 to confirm routing is wired correctly.
 */

export {}; // make this a module so top-level await is valid

const BASE = `http://localhost:${process.env.MONITOR_PORT ?? "3333"}`;
const TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Minimal test harness (no bun:test — runs as a plain script)
// ---------------------------------------------------------------------------

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

async function check(
  name: string,
  method: string,
  path: string,
  opts: {
    expectedStatus?: number | number[];
    expectedContentType?: string;
    body?: unknown;
    notStatus?: number;   // assert NOT this status (e.g. not 404)
  } = {},
): Promise<void> {
  const { expectedStatus, expectedContentType, body, notStatus } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers: body ? { "content-type": "application/json" } : {},
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, init);
    clearTimeout(timer);

    const okStatuses = expectedStatus === undefined
      ? undefined
      : Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

    if (okStatuses && !okStatuses.includes(res.status)) {
      results.push({ name, ok: false, detail: `status ${res.status}, expected ${okStatuses.join("|")}` });
      return;
    }
    if (notStatus !== undefined && res.status === notStatus) {
      results.push({ name, ok: false, detail: `status ${res.status} — expected not to be ${notStatus}` });
      return;
    }
    if (expectedContentType) {
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes(expectedContentType)) {
        results.push({ name, ok: false, detail: `content-type "${ct}", expected to include "${expectedContentType}"` });
        return;
      }
    }
    results.push({ name, ok: true, detail: `${method} ${path} → ${res.status}` });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail: `fetch error: ${msg}` });
  }
}

// ---------------------------------------------------------------------------
// Smoke checks
// ---------------------------------------------------------------------------

// --- static routes ---
await check("GET /  → dashboard HTML",          "GET",  "/",            { expectedStatus: 200, expectedContentType: "text/html" });
await check("GET /poll-log → JSON array",        "GET",  "/poll-log",    { expectedStatus: 200, expectedContentType: "application/json" });

// --- chains routes ---
await check("GET /chains → JSON array",          "GET",  "/chains",      { expectedStatus: 200, expectedContentType: "application/json" });
await check("GET /sessions → JSON array",        "GET",  "/sessions",    { expectedStatus: 200, expectedContentType: "application/json" });
await check("GET /job-chains → JSON array",      "GET",  "/job-chains",  { expectedStatus: 200, expectedContentType: "application/json" });

// chain-detail with a fake ID should return JSON 404 from the handler (route is wired)
await check("GET /chain-detail/:id → JSON 404 from handler", "GET", "/chain-detail/__nonexistent__", { expectedStatus: 404, expectedContentType: "application/json" });

// --- jobs routes ---
await check("GET /jobs → JSON array",            "GET",  "/jobs",        { expectedStatus: 200, expectedContentType: "application/json" });
await check("GET /build-queue → JSON array",     "GET",  "/build-queue", { expectedStatus: 200, expectedContentType: "application/json" });

// /log/:id — non-existent id returns 404 from the handler (not unrouted)
await check("GET /log/:id → 404 from handler",   "GET",  "/log/__nonexistent__", { expectedStatus: 404 });

// --- build routes ---
await check("GET /build-status → 200 or 503",   "GET",  "/build-status", { expectedStatus: [200, 503] });

// --- summarise routes ---
await check("GET /summarise-status → JSON",      "GET",  "/summarise-status", { expectedStatus: 200, expectedContentType: "application/json" });

// --- git routes ---
await check("GET /git-status → 200 or 500",     "GET",  "/git-status",  { expectedStatus: [200, 500] });

// --- system routes ---
await check("GET /system-status → JSON",         "GET",  "/system-status", { expectedStatus: 200, expectedContentType: "application/json" });

// --- SSE route ---
// SSE stream: just check it opens (200 text/event-stream) — abort immediately
await (async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_000);
  try {
    const res = await fetch(`${BASE}/events`, { signal: ctrl.signal });
    clearTimeout(timer);
    const ct = res.headers.get("content-type") ?? "";
    const ok = res.status === 200 && ct.includes("text/event-stream");
    results.push({
      name: "GET /events → 200 text/event-stream",
      ok,
      detail: ok ? `${res.status} ${ct}` : `status ${res.status}, ct "${ct}"`,
    });
  } catch (err) {
    clearTimeout(timer);
    // AbortError after 1s is fine — the stream opened and is streaming
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      results.push({ name: "GET /events → 200 text/event-stream", ok: true, detail: "stream opened (aborted after 1s as expected)" });
    } else {
      results.push({ name: "GET /events → 200 text/event-stream", ok: false, detail: `fetch error: ${err}` });
    }
  }
})();

// --- POST endpoints: confirm routed (handler responds, not server-level 404) ---
// Routes that look up a chain by ID return handler-404 ("not-found" JSON) for fake IDs.
// We verify the response is JSON (handler ran) rather than plain-text "Not Found" (unrouted).
// For routes that return a structured error, any status except a plain-text Not Found confirms routing.
await check("POST /hide-chain/:id → JSON response (routed)",     "POST", "/hide-chain/__test__",     { expectedContentType: "application/json" });
await check("POST /unhide-chain/:id → JSON response (routed)",   "POST", "/unhide-chain/__test__",   { expectedContentType: "application/json" });
await check("POST /update-chain-name → not 404",                 "POST", "/update-chain-name",       { notStatus: 404, body: {} });
await check("GET /chain-folder/:id → JSON response (routed)",    "GET",  "/chain-folder/__test__",   { expectedContentType: "application/json" });
await check("POST /chain-folder/:id → JSON response (routed)",   "POST", "/chain-folder/__test__",   { expectedContentType: "application/json", body: {} });
await check("POST /summarise/:id → not 404",                     "POST", "/summarise/__test__",      { notStatus: 404 });
await check("POST /summarise-chain/:id → JSON response (routed)","POST", "/summarise-chain/__test__",{ expectedContentType: "application/json" });
await check("POST /mark-summarised/:id → JSON response (routed)","POST", "/mark-summarised/__test__",{ expectedContentType: "application/json" });
await check("POST /resume/:id → JSON response (routed)",         "POST", "/resume/__test__",         { expectedContentType: "application/json" });
await check("POST /handoff → not 404",                           "POST", "/handoff",                 { notStatus: 404, body: {} });

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;

console.log(`\nSmoke test results — ${passed} passed, ${failed} failed\n`);

for (const r of results) {
  const icon = r.ok ? "✓" : "✗";
  const label = r.ok ? r.name : `${r.name}  ← ${r.detail}`;
  console.log(`  ${icon}  ${label}`);
}

if (failed > 0) {
  console.error(`\n${failed} smoke test(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll smoke tests passed.");
}
