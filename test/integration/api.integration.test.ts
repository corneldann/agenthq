// ---------------------------------------------------------------------------
// API Integration Tests — workspace filtering end-to-end
//
// Feature: multi-workspace-monitoring
// Validates: Requirements 5.1-5.20
//
// These tests spin up a real Bun HTTP server using the actual router and
// invoke route handlers directly.  Instead of mock.module() (which leaks
// across the entire test suite), the tests mock at the HTTP boundary: the
// server is given a fetch handler that imports and applies the REAL filtering
// logic (filterByWorkspace / createFilterResponse) with controlled test data
// injected inline.  This keeps the test hermetic without touching module
// globals that other test files depend on.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Chain, SessionState, Job, GitStatus } from '../../src/types.ts';
import type { WorkspaceConfig } from '../../src/config/workspace-config.ts';
import { filterByWorkspace, createFilterResponse } from '../../src/routes/helpers/filter.ts';
import { createRouter } from '../../src/router.ts';

// ---------------------------------------------------------------------------
// Controlled test data
// ---------------------------------------------------------------------------

const WORKSPACES: WorkspaceConfig[] = [
  {
    id: 'workspace-a',
    OUTPUT_DIR: '/tmp/ws-a/output',
    SESSIONS_DIR: '/tmp/ws-a/sessions',
    WORKSPACE_ROOT: '/tmp/ws-a',
  },
  {
    id: 'workspace-b',
    OUTPUT_DIR: '/tmp/ws-b/output',
    SESSIONS_DIR: '/tmp/ws-b/sessions',
    WORKSPACE_ROOT: '/tmp/ws-b',
  },
];

const CHAINS: Chain[] = [
  {
    chainId: 'chain-a-1',
    displayName: 'Chain A1',
    workspaceId: 'workspace-a',
    totalMessages: 5,
    nextIndex: 2,
    sessions: [],
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-02T00:00:00Z',
    workflowCount: 1,
  },
  {
    chainId: 'chain-a-2',
    displayName: 'Chain A2',
    workspaceId: 'workspace-a',
    totalMessages: 3,
    nextIndex: 1,
    sessions: [],
    createdAt: '2026-01-03T00:00:00Z',
    lastActiveAt: '2026-01-04T00:00:00Z',
    workflowCount: 1,
  },
  {
    chainId: 'chain-b-1',
    displayName: 'Chain B1',
    workspaceId: 'workspace-b',
    totalMessages: 7,
    nextIndex: 3,
    sessions: [],
    createdAt: '2026-01-05T00:00:00Z',
    lastActiveAt: '2026-01-06T00:00:00Z',
    workflowCount: 2,
  },
];

const SESSIONS: SessionState[] = [
  {
    workflowHash: 'wh-a-001',
    sessionJsonl: 'wh-a-001.jsonl',
    chainId: 'chain-a-1',
    chainIndex: 0,
    previousSession: '',
    topic: 'Session A1',
    messageCount: 5,
    userMessageCount: 3,
    contextUsagePct: 25,
    lastMessageAt: '2026-01-02T00:00:00Z',
    lastSummarisedMessageCount: 0,
    lastSummarisedAt: '',
    summaryFile: '',
    status: 'idle',
    firstUserMessage: 'hello',
    lastUserMessage: 'bye',
    lastAgentMessage: 'done',
    startTime: '2026-01-01T00:00:00Z',
    workspaceId: 'workspace-a',
  },
  {
    workflowHash: 'wh-b-001',
    sessionJsonl: 'wh-b-001.jsonl',
    chainId: 'chain-b-1',
    chainIndex: 0,
    previousSession: '',
    topic: 'Session B1',
    messageCount: 7,
    userMessageCount: 4,
    contextUsagePct: 50,
    lastMessageAt: '2026-01-06T00:00:00Z',
    lastSummarisedMessageCount: 0,
    lastSummarisedAt: '',
    summaryFile: '',
    status: 'active',
    firstUserMessage: 'start',
    lastUserMessage: 'end',
    lastAgentMessage: 'response',
    startTime: '2026-01-05T00:00:00Z',
    workspaceId: 'workspace-b',
  },
];

const JOBS: Job[] = [
  {
    id: 'job-a-1',
    name: 'test-job-alpha',
    jobChain: 'test-job-alpha',
    sessionChainId: 'chain-a-1',
    timestamp: '2026-01-01T10:00:00Z',
    type: 'prompt',
    agent: 'test-agent',
    status: 'done',
    lines: 10,
    lastLine: 'Done',
    hasLog: false,
    logError: false,
    mdFile: 'job-a-1.md',
    logFile: '',
    agentDone: 'yes',
    sizeBytes: 1024,
    workspaceId: 'workspace-a',
  },
  {
    id: 'job-b-1',
    name: 'test-job-beta',
    jobChain: 'test-job-beta',
    sessionChainId: 'chain-b-1',
    timestamp: '2026-01-05T10:00:00Z',
    type: 'crawl',
    agent: 'crawler',
    status: 'running',
    lines: 5,
    lastLine: 'running...',
    hasLog: true,
    logError: false,
    mdFile: 'job-b-1.md',
    logFile: 'job-b-1.log',
    agentDone: '',
    sizeBytes: 512,
    workspaceId: 'workspace-b',
  },
];

const GIT_STATUSES: GitStatus[] = [
  {
    branch: 'main',
    clean: true,
    modified: [],
    staged: [],
    untracked: [],
    ahead: 0,
    behind: 0,
    workspaceId: 'workspace-a',
  },
  {
    branch: 'feature/test',
    clean: false,
    modified: ['src/foo.ts'],
    staged: [],
    untracked: ['new-file.ts'],
    ahead: 1,
    behind: 0,
    workspaceId: 'workspace-b',
  },
];

// ---------------------------------------------------------------------------
// Test server — built directly from the real router + real filter helpers,
// with controlled data injected as closures.  No mock.module() is used so
// the module registry is not polluted.
// ---------------------------------------------------------------------------

const TEST_PORT = 19877;

/**
 * Build a minimal fetch handler that mirrors the real route structure but
 * sources data from the controlled test fixtures above.
 *
 * This faithfully exercises:
 *  - URL / query string parsing (new URL(req.url).searchParams)
 *  - filterByWorkspace() — the real implementation
 *  - createFilterResponse() — the real implementation
 *  - JSON serialisation and response headers
 */
function buildTestFetch(base: string): (req: Request) => Promise<Response> {
  const router = createRouter();

  // GET /chains
  router.get('/chains', async (req) => {
    const wsId = new URL(req.url).searchParams.get('workspaceId') || undefined;
    // Mirror real route: filter out stub chains (totalMessages <= 1)
    const chains = CHAINS.filter(c => (c.totalMessages ?? 0) > 1);
    return createFilterResponse(filterByWorkspace(chains, wsId, WORKSPACES));
  });

  // GET /jobs
  router.get('/jobs', async (req) => {
    const wsId = new URL(req.url).searchParams.get('workspaceId') || undefined;
    return createFilterResponse(filterByWorkspace(JOBS, wsId, WORKSPACES));
  });

  // GET /sessions
  router.get('/sessions', async (req) => {
    const wsId = new URL(req.url).searchParams.get('workspaceId') || undefined;
    return createFilterResponse(filterByWorkspace(SESSIONS, wsId, WORKSPACES));
  });

  // GET /git-status
  router.get('/git-status', async (req) => {
    const wsId = new URL(req.url).searchParams.get('workspaceId') || undefined;
    // Mirror real git-status route: build one status per workspace
    const allStatuses = WORKSPACES.map(ws => {
      const found = GIT_STATUSES.find(g => g.workspaceId === ws.id);
      return found ?? {
        branch: 'unknown',
        clean: true,
        modified: [] as string[],
        staged: [] as string[],
        untracked: [] as string[],
        ahead: 0,
        behind: 0,
        workspaceId: ws.id,
      };
    });
    return createFilterResponse(filterByWorkspace(allStatuses, wsId, WORKSPACES));
  });

  return async (req: Request) => {
    const match = router.match(req);
    if (match) return await match.handler(req, match.params);
    return new Response('Not found', { status: 404 });
  };
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  const fetchHandler = buildTestFetch(`http://localhost:${TEST_PORT}`);
  server = Bun.serve({
    port: TEST_PORT,
    fetch: fetchHandler,
  });
});

afterAll(() => {
  server?.stop(true);
});

function url(path: string): string {
  return `http://localhost:${TEST_PORT}${path}`;
}

// ---------------------------------------------------------------------------
// 5.1-5.5 — /chains workspace filtering
// ---------------------------------------------------------------------------

describe('GET /chains — workspace filtering (Requirements 5.1–5.5)', () => {
  // Req 5.5: no filter → returns all chains (200)
  test('5.5 — no workspaceId returns all chains (200)', async () => {
    const res = await fetch(url('/chains'));
    expect(res.status).toBe(200);
    const body = await res.json() as Chain[];
    expect(body.length).toBe(CHAINS.length);
  });

  // Req 5.1 + 5.3: valid workspaceId with data → returns only matching chains
  test('5.1/5.3 — valid workspaceId returns only matching chains (200)', async () => {
    const res = await fetch(url('/chains?workspaceId=workspace-a'));
    expect(res.status).toBe(200);
    const body = await res.json() as Chain[];
    expect(body.every(c => c.workspaceId === 'workspace-a')).toBe(true);
    const expected = CHAINS.filter(c => c.workspaceId === 'workspace-a').length;
    expect(body.length).toBe(expected);
  });

  // Req 5.2: case-sensitive — WORKSPACE-A must not match workspace-a
  test('5.2 — workspaceId filter is case-sensitive (404 for wrong case)', async () => {
    const res = await fetch(url('/chains?workspaceId=WORKSPACE-A'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('WORKSPACE-A');
  });

  // Req 5.4: invalid workspaceId → 404 with error message
  test('5.4 — invalid workspaceId returns 404 with error message', async () => {
    const res = await fetch(url('/chains?workspaceId=nonexistent-ws'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('nonexistent-ws');
  });

  // Req 5.4.1: valid workspace with no matching chains → 200 empty array
  // workspace-b has exactly one chain; verify filtering returns only workspace-b items
  test('5.4.1 — valid workspace with chains returns correct subset (200)', async () => {
    const res = await fetch(url('/chains?workspaceId=workspace-b'));
    expect(res.status).toBe(200);
    const body = await res.json() as Chain[];
    expect(body.every(c => c.workspaceId === 'workspace-b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5.6-5.10 — /jobs workspace filtering
// ---------------------------------------------------------------------------

describe('GET /jobs — workspace filtering (Requirements 5.6–5.10)', () => {
  // Req 5.10: no filter → returns all jobs (200)
  test('5.10 — no workspaceId returns all jobs (200)', async () => {
    const res = await fetch(url('/jobs'));
    expect(res.status).toBe(200);
    const body = await res.json() as Job[];
    expect(body.length).toBe(JOBS.length);
  });

  // Req 5.6 + 5.8: valid workspaceId with data → returns only matching jobs
  test('5.6/5.8 — valid workspaceId returns only matching jobs (200)', async () => {
    const res = await fetch(url('/jobs?workspaceId=workspace-a'));
    expect(res.status).toBe(200);
    const body = await res.json() as Job[];
    expect(body.every(j => j.workspaceId === 'workspace-a')).toBe(true);
    expect(body.length).toBe(JOBS.filter(j => j.workspaceId === 'workspace-a').length);
  });

  // Req 5.7: case-sensitive matching
  test('5.7 — workspaceId filter is case-sensitive (404 for wrong case)', async () => {
    const res = await fetch(url('/jobs?workspaceId=Workspace-A'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Workspace-A');
  });

  // Req 5.9: invalid workspaceId → 404 with error message
  test('5.9 — invalid workspaceId returns 404 with error message', async () => {
    const res = await fetch(url('/jobs?workspaceId=no-such-workspace'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('no-such-workspace');
  });

  // Req 5.9.1: valid workspace with its jobs returns them (200)
  test('5.9.1 — valid workspace returns its jobs (200)', async () => {
    const res = await fetch(url('/jobs?workspaceId=workspace-b'));
    expect(res.status).toBe(200);
    const body = await res.json() as Job[];
    expect(body.every(j => j.workspaceId === 'workspace-b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5.11-5.15 — /sessions workspace filtering
// ---------------------------------------------------------------------------

describe('GET /sessions — workspace filtering (Requirements 5.11–5.15)', () => {
  // Req 5.15: no filter → returns all sessions (200)
  test('5.15 — no workspaceId returns all sessions (200)', async () => {
    const res = await fetch(url('/sessions'));
    expect(res.status).toBe(200);
    const body = await res.json() as SessionState[];
    expect(body.length).toBe(SESSIONS.length);
  });

  // Req 5.11 + 5.13: valid workspaceId with data → returns only matching sessions
  test('5.11/5.13 — valid workspaceId returns only matching sessions (200)', async () => {
    const res = await fetch(url('/sessions?workspaceId=workspace-a'));
    expect(res.status).toBe(200);
    const body = await res.json() as SessionState[];
    expect(body.every(s => s.workspaceId === 'workspace-a')).toBe(true);
    expect(body.length).toBe(SESSIONS.filter(s => s.workspaceId === 'workspace-a').length);
  });

  // Req 5.12: case-sensitive matching
  test('5.12 — workspaceId filter is case-sensitive (404 for wrong case)', async () => {
    const res = await fetch(url('/sessions?workspaceId=WORKSPACE-B'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('WORKSPACE-B');
  });

  // Req 5.14: invalid workspaceId → 404 with error message
  test('5.14 — invalid workspaceId returns 404 with error message', async () => {
    const res = await fetch(url('/sessions?workspaceId=ghost-workspace'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('ghost-workspace');
  });

  // Req 5.14.1: valid workspace returns its sessions (200)
  test('5.14.1 — valid workspace returns its sessions (200)', async () => {
    const res = await fetch(url('/sessions?workspaceId=workspace-b'));
    expect(res.status).toBe(200);
    const body = await res.json() as SessionState[];
    expect(body.every(s => s.workspaceId === 'workspace-b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5.16-5.20 — /git-status workspace filtering
// ---------------------------------------------------------------------------

describe('GET /git-status — workspace filtering (Requirements 5.16–5.20)', () => {
  // Req 5.20: no filter → returns all git statuses (200)
  test('5.20 — no workspaceId returns all git statuses (200)', async () => {
    const res = await fetch(url('/git-status'));
    expect(res.status).toBe(200);
    const body = await res.json() as GitStatus[];
    expect(body.length).toBe(WORKSPACES.length);
  });

  // Req 5.16 + 5.18: valid workspaceId → returns only matching git status
  test('5.16/5.18 — valid workspaceId returns only matching git status (200)', async () => {
    const res = await fetch(url('/git-status?workspaceId=workspace-a'));
    expect(res.status).toBe(200);
    const body = await res.json() as GitStatus[];
    expect(body.every(g => g.workspaceId === 'workspace-a')).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].branch).toBe('main');
    expect(body[0].clean).toBe(true);
  });

  // Req 5.17: case-sensitive matching
  test('5.17 — workspaceId filter is case-sensitive (404 for wrong case)', async () => {
    const res = await fetch(url('/git-status?workspaceId=Workspace-A'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Workspace-A');
  });

  // Req 5.19: invalid workspaceId → 404 with error message
  test('5.19 — invalid workspaceId returns 404 with error message', async () => {
    const res = await fetch(url('/git-status?workspaceId=phantom-workspace'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('phantom-workspace');
  });

  // Req 5.19.1: valid workspace with data returns it (200)
  test('5.19.1 — valid workspace-b returns its git status (200)', async () => {
    const res = await fetch(url('/git-status?workspaceId=workspace-b'));
    expect(res.status).toBe(200);
    const body = await res.json() as GitStatus[];
    expect(body.every(g => g.workspaceId === 'workspace-b')).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].branch).toBe('feature/test');
    expect(body[0].clean).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Response format and headers
// ---------------------------------------------------------------------------

describe('Response format and headers', () => {
  test('JSON content-type header on success responses', async () => {
    const routes = ['/chains', '/jobs', '/sessions', '/git-status'];
    for (const route of routes) {
      const res = await fetch(url(route));
      const ct = res.headers.get('content-type');
      expect(ct).toContain('application/json');
    }
  });

  test('JSON content-type header on 404 responses', async () => {
    const routes = [
      '/chains?workspaceId=bad-ws',
      '/jobs?workspaceId=bad-ws',
      '/sessions?workspaceId=bad-ws',
      '/git-status?workspaceId=bad-ws',
    ];
    for (const route of routes) {
      const res = await fetch(url(route));
      expect(res.status).toBe(404);
      const ct = res.headers.get('content-type');
      expect(ct).toContain('application/json');
    }
  });

  test('404 error body is valid JSON with an error field', async () => {
    const res = await fetch(url('/chains?workspaceId=does-not-exist'));
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect((body.error as string).length).toBeGreaterThan(0);
  });

  test('200 success body is a JSON array', async () => {
    const routes = ['/chains', '/jobs', '/sessions', '/git-status'];
    for (const route of routes) {
      const res = await fetch(url(route));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

describe('Query parameter parsing', () => {
  test('workspaceId is correctly parsed from URL query string', async () => {
    const res = await fetch(url('/jobs?workspaceId=workspace-a'));
    expect(res.status).toBe(200);
    const body = await res.json() as Job[];
    // All returned jobs belong to workspace-a → param was correctly parsed
    expect(body.every(j => j.workspaceId === 'workspace-a')).toBe(true);
  });

  test('extra query params alongside workspaceId are ignored', async () => {
    const res = await fetch(url('/jobs?workspaceId=workspace-a&extra=ignored'));
    expect(res.status).toBe(200);
    const body = await res.json() as Job[];
    expect(body.every(j => j.workspaceId === 'workspace-a')).toBe(true);
  });

  test('workspaceId with URL-encoded special chars triggers 404 (no such workspace)', async () => {
    // %20 decodes to a space — "workspace a" is not a configured workspace
    const res = await fetch(url('/chains?workspaceId=workspace%20a'));
    expect(res.status).toBe(404);
  });

  test('missing workspaceId param returns all data', async () => {
    const resNoParam = await fetch(url('/chains'));
    const bodyNoParam = await resNoParam.json() as Chain[];

    expect(resNoParam.status).toBe(200);
    expect(bodyNoParam.length).toBe(CHAINS.length);
  });

  test('empty workspaceId param returns all data', async () => {
    const resEmptyParam = await fetch(url('/chains?workspaceId='));
    const bodyEmptyParam = await resEmptyParam.json() as Chain[];

    expect(resEmptyParam.status).toBe(200);
    expect(bodyEmptyParam.length).toBe(CHAINS.length);
  });
});

// ---------------------------------------------------------------------------
// Data isolation — verify cross-workspace contamination does not occur
// ---------------------------------------------------------------------------

describe('Data isolation across workspaces', () => {
  test('workspace-a chains do not appear in workspace-b results', async () => {
    const resA = await fetch(url('/chains?workspaceId=workspace-a'));
    const resB = await fetch(url('/chains?workspaceId=workspace-b'));
    const bodyA = await resA.json() as Chain[];
    const bodyB = await resB.json() as Chain[];

    const idsA = new Set(bodyA.map(c => c.chainId));
    const idsB = new Set(bodyB.map(c => c.chainId));
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  test('workspace-a jobs do not appear in workspace-b results', async () => {
    const resA = await fetch(url('/jobs?workspaceId=workspace-a'));
    const resB = await fetch(url('/jobs?workspaceId=workspace-b'));
    const bodyA = await resA.json() as Job[];
    const bodyB = await resB.json() as Job[];

    const idsA = new Set(bodyA.map(j => j.id));
    const idsB = new Set(bodyB.map(j => j.id));
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  test('workspace-a sessions do not appear in workspace-b results', async () => {
    const resA = await fetch(url('/sessions?workspaceId=workspace-a'));
    const resB = await fetch(url('/sessions?workspaceId=workspace-b'));
    const bodyA = await resA.json() as SessionState[];
    const bodyB = await resB.json() as SessionState[];

    const hashesA = new Set(bodyA.map(s => s.workflowHash));
    const hashesB = new Set(bodyB.map(s => s.workflowHash));
    for (const h of hashesA) {
      expect(hashesB.has(h)).toBe(false);
    }
  });

  test('union of workspace-a and workspace-b results equals unfiltered results', async () => {
    // Chains
    const allChains = await fetch(url('/chains')).then(r => r.json()) as Chain[];
    const chainA = await fetch(url('/chains?workspaceId=workspace-a')).then(r => r.json()) as Chain[];
    const chainB = await fetch(url('/chains?workspaceId=workspace-b')).then(r => r.json()) as Chain[];
    expect(chainA.length + chainB.length).toBe(allChains.length);

    // Jobs
    const allJobs = await fetch(url('/jobs')).then(r => r.json()) as Job[];
    const jobsA = await fetch(url('/jobs?workspaceId=workspace-a')).then(r => r.json()) as Job[];
    const jobsB = await fetch(url('/jobs?workspaceId=workspace-b')).then(r => r.json()) as Job[];
    expect(jobsA.length + jobsB.length).toBe(allJobs.length);

    // Sessions
    const allSessions = await fetch(url('/sessions')).then(r => r.json()) as SessionState[];
    const sessionsA = await fetch(url('/sessions?workspaceId=workspace-a')).then(r => r.json()) as SessionState[];
    const sessionsB = await fetch(url('/sessions?workspaceId=workspace-b')).then(r => r.json()) as SessionState[];
    expect(sessionsA.length + sessionsB.length).toBe(allSessions.length);
  });
});
