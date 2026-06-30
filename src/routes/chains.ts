// routes/chains.ts — Chain, session, job-chain, and chain-detail route handlers.

import type { Router } from '../router.ts';
import type { Job, JobChain, SessionState } from '../types.ts';
import { CHAINS_DIR } from '../constants.ts';
import { scanChains } from '../scan/chains.ts';
import { scanSessions } from '../scan/sessions.ts';
import { scanJobs } from '../scan/jobs.ts';

export function register(router: Router): void {
  // ------------------------------------------------------------------
  // GET /job-chains — jobs grouped by jobChain name, linked to session chains
  // ------------------------------------------------------------------
  router.get('/job-chains', async (_req, _params) => {
    const jobs = await scanJobs();
    const map = new Map<string, Job[]>();
    for (const j of jobs) {
      const key = j.jobChain || j.name;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(j);
    }
    const chains: JobChain[] = [];
    for (const [jobChain, runs] of map) {
      runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const latest = runs[0];
      const sessionChainId = runs.find(r => r.sessionChainId)?.sessionChainId ?? "";
      chains.push({
        jobChain,
        sessionChainId,
        type: latest.type,
        latestStatus: latest.status,
        latestTimestamp: latest.timestamp,
        runCount: runs.length,
        runs,
      });
    }
    chains.sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp));
    return new Response(JSON.stringify(chains), {
      headers: { "content-type": "application/json", "connection": "close" },
    });
  });

  // ------------------------------------------------------------------
  // GET /sessions — full list of SessionState objects
  // ------------------------------------------------------------------
  router.get('/sessions', async (_req, _params) => {
    const sessions = await scanSessions();
    return new Response(JSON.stringify(sessions), {
      headers: { "content-type": "application/json", "connection": "close" },
    });
  });

  // ------------------------------------------------------------------
  // GET /chains — filtered array of Chain objects (totalMessages > 1)
  // ------------------------------------------------------------------
  router.get('/chains', async (_req, _params) => {
    const chains = await scanChains(CHAINS_DIR, await scanSessions());
    // Filter out stub chains (≤1 message) — these are corrupt/truncated session artifacts
    const filtered = chains.filter(c => (c.totalMessages ?? 0) > 1);
    return new Response(JSON.stringify(filtered), {
      headers: { "content-type": "application/json", "connection": "close" },
    });
  });

  // ------------------------------------------------------------------
  // GET /chain-detail/:chainId — full session timeline for the drawer
  // ------------------------------------------------------------------
  router.get('/chain-detail/:chainId', async (_req, params) => {
    const chainId = decodeURIComponent(params.chainId);
    const chains = await scanChains(CHAINS_DIR, await scanSessions());
    const chain = chains.find((c) => c.chainId === chainId);
    if (!chain) {
      return Response.json({ status: "not-found" }, { status: 404 });
    }

    const sessionsList = await scanSessions();
    const sessionsByHash = new Map<string, SessionState>(
      sessionsList.map((s) => [s.workflowHash, s])
    );

    // Build full session timeline with state info
    const timeline = chain.sessions.map((entry) => {
      const sess = sessionsByHash.get(entry.workflowHash);
      return {
        index: entry.index,
        date: entry.date,
        messageCount: entry.messageCount,
        status: sess?.status ?? entry.status,
        contextUsagePct: sess?.contextUsagePct ?? 0,
        firstUserMessage: sess?.firstUserMessage ?? "",
        lastUserMessage: sess?.lastUserMessage ?? "",
        lastAgentMessage: (sess as any)?.lastAgentMessage ?? "",
        topic: sess?.topic ?? "",
        workflowHash: entry.workflowHash,
      };
    });

    return Response.json({
      chainId: chain.chainId,
      displayName: chain.displayName,
      totalMessages: chain.totalMessages,
      workflowCount: chain.workflowCount,
      createdAt: chain.createdAt,
      lastActiveAt: chain.lastActiveAt,
      overallStatus: chain.overallStatus,
      timeline,
    }, {
      headers: { "connection": "close" },
    });
  });
}
