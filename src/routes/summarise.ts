// routes/summarise.ts — Summarise, summarise-chain, summarise-status, and mark-summarised handlers.

import path from "node:path";
import type { Router } from '../router.ts';
import type { SessionState } from '../types.ts';
import { WORKSPACE_ROOT, CHAINS_DIR, KIRO_TOOLS_DIR, WORKFLOW_DIR } from '../constants.ts';
import { scanChains } from '../scan/chains.ts';
import { scanSessions } from '../scan/sessions.ts';
import { invalidateScanCache } from '../scan/cache.ts';
import { summariseInFlight, saveSummariseState } from '../workers/summariseState.ts';

// ---------------------------------------------------------------------------
// Local helper — resolve the timestamp folder path for a chainId
// ---------------------------------------------------------------------------
async function chainFolder(chainId: string): Promise<string | null> {
  try {
    const dirs = await import("node:fs/promises").then(fs => fs.readdir(
      path.join(WORKSPACE_ROOT, ".kiro", "sessions")
    ));
    const match = dirs.find(d => d.endsWith(`_${chainId}`) && /^\d{4}-\d{2}-\d{2}/.test(d));
    if (match) return path.join(WORKSPACE_ROOT, ".kiro", "sessions", match);
    const orphan = path.join(WORKSPACE_ROOT, ".kiro", "sessions", "_orphan-chains", chainId);
    if (await Bun.file(path.join(orphan, "chain.json")).exists()) return orphan;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

export function register(router: Router): void {

  // ------------------------------------------------------------------
  // POST /summarise-chain/:chainId — full chain consolidation summary
  // ------------------------------------------------------------------
  router.post('/summarise-chain/:chainId', async (_req, params) => {
    const chainId = decodeURIComponent(params.chainId);
    const chains = await scanChains(CHAINS_DIR, await scanSessions());
    const chain = chains.find((c) => c.chainId === chainId);
    if (!chain) {
      return Response.json({ status: "not-found" }, { status: 404 });
    }

    const chainDir = (await chainFolder(chainId)) ?? path.join(WORKSPACE_ROOT, ".kiro", "sessions", chainId);
    const chainJsonPath = path.join(chainDir, "chain.json");
    const outputFile = path.join(chainDir, "chain-summary.md");
    const outputDir = path.join(WORKSPACE_ROOT, "docs", "analysis", "prompts", "output");

    // Build sessions JSON — for each deduplicated session, find the State file with
    // the HIGHEST messageCount for that chatSessionId (most complete snapshot)
    const sessionsList = await scanSessions();

    const bestByChatSession = new Map<string, SessionState>();
    for (const s of sessionsList) {
      if (!s.chatSessionId) continue;
      const existing = bestByChatSession.get(s.chatSessionId);
      if (!existing || (s.messageCount ?? 0) > (existing.messageCount ?? 0)) {
        bestByChatSession.set(s.chatSessionId, s);
      }
    }
    const sessionsByHash = new Map<string, SessionState>(
      sessionsList.map((s) => [s.workflowHash, s])
    );

    const sessionsData = chain.sessions.map((entry) => {
      const directState = sessionsByHash.get(entry.workflowHash);
      const chatId = directState?.chatSessionId;
      const sess = (chatId ? bestByChatSession.get(chatId) : null) ?? directState;
      return {
        index: entry.index,
        date: entry.date,
        workflowHash: sess?.workflowHash ?? entry.workflowHash,
        chatSessionId: chatId ?? "",
        messageCount: sess?.messageCount ?? entry.messageCount,
        status: sess?.status ?? entry.status,
        contextUsagePct: sess?.contextUsagePct ?? 0,
        firstUserMessage: sess?.firstUserMessage ?? "",
        lastUserMessage: sess?.lastUserMessage ?? "",
        lastAgentMessage: (sess as SessionState & { lastAgentMessage?: string })?.lastAgentMessage ?? "",
        topic: sess?.topic ?? "",
        startTime: sess?.startTime ?? entry.date,
        lastMessageAt: sess?.lastMessageAt ?? "",
      };
    });
    const sessionsJsonPath = path.join(chainDir, ".sessions-snapshot.json");
    await Bun.write(sessionsJsonPath, JSON.stringify(sessionsData, null, 2));

    const argsPath = path.join(chainDir, ".summarise-args.json");
    await Bun.write(argsPath, JSON.stringify({
      CHAIN_ID: chainId,
      DISPLAY_NAME: chain.displayName,
      CHAIN_DIR: chainDir,
      CHAIN_JSON: chainJsonPath,
      SESSIONS_JSON: sessionsJsonPath,
      OUTPUT_FILE: outputFile,
    }));

    type SayAction = { actionType: string; output?: { message?: string } };
    type WorkflowFile = { actions?: SayAction[] };

    async function extractSayActions(workflowHash: string): Promise<string[]> {
      const filePath = path.join(WORKFLOW_DIR, workflowHash);
      try {
        const raw = await Bun.file(filePath).text();
        const wf = JSON.parse(raw) as WorkflowFile;
        if (!wf.actions) return [];
        return wf.actions
          .filter(a => a.actionType === "say" && a.output?.message)
          .map(a => a.output!.message!);
      } catch {
        return [];
      }
    }

    let lastSummaryDate = "";
    const summaryFile = Bun.file(outputFile);
    if (await summaryFile.exists()) {
      const raw = await summaryFile.text();
      const match = raw.match(/\*\*Generated\*\*:\s*(.+)/);
      if (match) lastSummaryDate = match[1].trim().slice(0, 10);
    }

    const enhancedSessions = await Promise.all(sessionsData.map(async (s) => {
      const isNew = !lastSummaryDate || (s.startTime || s.date) > lastSummaryDate;
      let conversation: string[] = [];
      if (isNew && s.workflowHash) {
        conversation = await extractSayActions(s.workflowHash);
      }
      return { ...s, conversation, isNew };
    }));

    const sessionsEmbedded = enhancedSessions.map(s => {
      const header = `### Session ${s.index} — ${s.startTime} (${s.messageCount} msgs, ${s.status})\n**Topic**: ${s.topic || "(unknown)"}\n**isNew**: ${s.isNew}`;
      if (!s.isNew) {
        return header + `\n*(already summarised — topic: ${s.topic})*`;
      }
      if (s.conversation.length > 0) {
        const turns = s.conversation.map((msg, i) => {
          const role = i % 2 === 0 ? "User" : "Kiro";
          const truncated = msg.length > 400 ? msg.slice(0, 400) + "…" : msg;
          return `**${role}**: ${truncated}`;
        }).join("\n\n");
        return header + `\n\n${turns}`;
      }
      return header + `\n**First message**: ${s.firstUserMessage}\n**Last message**: ${s.lastUserMessage}\n**Last response**: ${(s as typeof s & { lastAgentMessage?: string }).lastAgentMessage || ""}`;
    }).join("\n\n---\n\n");

    const workerScript = path.join(KIRO_TOOLS_DIR, "sw_agent_worker.ps1");
    const promptTemplate = await Bun.file(path.join(KIRO_TOOLS_DIR, "prompts", "summarise-chain.md")).text();

    let existingSummary = "(none — this is the first summary)";
    if (await summaryFile.exists()) {
      existingSummary = await summaryFile.text();
    }

    const substituted = promptTemplate
      .replace(/\{\{CHAIN_ID\}\}/g, chainId)
      .replace(/\{\{DISPLAY_NAME\}\}/g, chain.displayName)
      .replace(/\{\{CHAIN_DIR\}\}/g, chainDir)
      .replace(/\{\{CHAIN_JSON\}\}/g, chainJsonPath)
      .replace(/\{\{SESSIONS_JSON\}\}/g, sessionsJsonPath)
      .replace(/\{\{OUTPUT_FILE\}\}/g, outputFile)
      .replace(/\{\{WORKFLOW_DIR\}\}/g, path.join(
        process.env.APPDATA ?? "",
        "Kiro", "User", "globalStorage", "kiro.kiroagent",
        "c63f7a0d8b77479ab89f1bc6e7131b78", "414d1636299d2b9e4ce7e17fb11f63e9"
      ))
      .replace(/\{\{EXISTING_SUMMARY\}\}/g, existingSummary)
      .replace(/\{\{SESSIONS_DATA\}\}/g, sessionsEmbedded);

    const substitutedPromptPath = path.join(chainDir, `.summarise-prompt.md`);
    await Bun.write(substitutedPromptPath, substituted);
    console.log(`[summarise-chain] prompt written: ${substitutedPromptPath}`);

    const chainSlug = chainId.slice(0, 20).replace(/[^a-z0-9-]/g, "-").replace(/-+$/, "");
    const tmpBat = path.join(KIRO_TOOLS_DIR, `.summarise-chain-${chainId.slice(0,12)}.bat`);
    const utf8 = new TextEncoder();
    const batLines = [
      "@echo off",
      `cd /d "${WORKSPACE_ROOT}"`,
      `for /f "tokens=2*" %%a in ('reg query HKCU\\Environment /v OPENROUTER_API_KEY 2^>nul') do set OPENROUTER_API_KEY=%%b`,
      `powershell.exe -ExecutionPolicy Bypass -File "${workerScript}" -PromptFile "${substitutedPromptPath}" -OutputDir "${outputDir}" -Type "session-summary" -Stem "summarise-${chainSlug}"`,
    ].join("\r\n");
    await Bun.write(tmpBat, utf8.encode(batLines));
    console.log(`[summarise-chain] bat written: ${tmpBat}`);

    Bun.spawn(["cmd.exe", "/c", tmpBat], {
      cwd: WORKSPACE_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    console.log(`[summarise-chain] spawn launched for ${chainId}`);

    const outputStem = path.basename(substitutedPromptPath, ".md");
    summariseInFlight.set(chainId, outputStem);
    saveSummariseState().catch(() => {});

    return Response.json({ status: "queued", outputFile });
  });

  // ------------------------------------------------------------------
  // POST /summarise/:chainId — delta summary for latest session
  // ------------------------------------------------------------------
  router.post('/summarise/:chainId', async (_req, params) => {
    const chainId = decodeURIComponent(params.chainId);
    const jobId = `${Date.now()}-${chainId}-summary`;

    // Return 202 immediately — scanChains() is slow on cold cache, don't block the event loop
    (async () => {
      try {
        const chains = await scanChains(CHAINS_DIR, await scanSessions());
        const chain = chains.find((c) => c.chainId === chainId);
        if (!chain || !chain.latestSession) return;
        const delta = chain.unsummarisedDelta ?? 0;
        if (delta === 0) return;
        const sess = chain.latestSession;
        const dateStr = new Date().toISOString().slice(0, 10);
        const folder = await chainFolder(chainId) ?? path.join(WORKSPACE_ROOT, ".kiro", "sessions", chainId);
        const summaryFile = `${folder}/${sess.chainIndex}-${dateStr}-summary.md`;
        const chainMd = `${folder}/chain.md`;
        const fromMsg = sess.lastSummarisedMessageCount;
        const toMsg = sess.messageCount;
        const workerScript = path.join(KIRO_TOOLS_DIR, "sw_agent_worker.ps1");
        const promptFile = path.join(KIRO_TOOLS_DIR, "prompts", "summarise-session-delta.md");
        const outputDir = path.join(WORKSPACE_ROOT, "docs", "analysis", "prompts", "output");
        summariseInFlight.set(chainId, jobId);
        saveSummariseState().catch(() => {});
        Bun.spawn(
          [
            "powershell.exe", "-ExecutionPolicy", "Bypass",
            "-Command",
            `& '${workerScript}' -PromptFile '${promptFile}' -OutputDir '${outputDir}' -Type 'session-summary' -TemplateArgs @{WORKFLOW_HASH='${sess.workflowHash}';FROM_MSG='${fromMsg}';TO_MSG='${toMsg}';SUMMARY_FILE='${summaryFile}';CHAIN_MD='${chainMd}'}`,
          ],
          { cwd: WORKSPACE_ROOT, stderr: "ignore", stdout: "ignore" }
        );
        console.log(`[summarise] spawned worker for ${chainId}`);
      } catch (e) {
        console.error(`[summarise] error for ${chainId}:`, e);
      }
    })();

    return Response.json({ status: "queued", jobId });
  });

  // ------------------------------------------------------------------
  // GET /summarise-status — map of chainId -> "running"|"idle"
  // ------------------------------------------------------------------
  router.get('/summarise-status', (_req, _params) => {
    const status: Record<string, string> = {};
    for (const [chainId] of summariseInFlight) {
      status[chainId] = "running";
    }
    return new Response(JSON.stringify(status), {
      headers: { "content-type": "application/json", "connection": "close" },
    });
  });

  // ------------------------------------------------------------------
  // POST /mark-summarised/:chainId — zero the unsummarised delta for all sessions
  // ------------------------------------------------------------------
  router.post('/mark-summarised/:chainId', async (_req, params) => {
    const chainId = decodeURIComponent(params.chainId);
    const chains = await scanChains(CHAINS_DIR, await scanSessions());
    const chain = chains.find((c) => c.chainId === chainId);
    if (!chain) {
      return Response.json({ status: "not-found" }, { status: 404 });
    }

    const { readdir, readFile, writeFile } = await import("node:fs/promises");
    const sessionsBase = path.join(WORKSPACE_ROOT, ".kiro", "sessions");
    let updated = 0;

    for (const entry of chain.sessions) {
      const dirs = await readdir(sessionsBase).catch(() => [] as string[]);
      const chainDirName = dirs.find(d => d.endsWith(`_${chainId}`) && /^\d{4}-\d{2}-\d{2}/.test(d));
      if (!chainDirName) continue;

      const stateDir = path.join(sessionsBase, chainDirName, "State");
      const stateFiles = await readdir(stateDir).catch(() => [] as string[]);

      const stateFile = stateFiles.find(f => f === `${entry.workflowHash}.json`);
      if (!stateFile) continue;

      const filePath = path.join(stateDir, stateFile);
      try {
        const raw = await readFile(filePath, "utf8");
        const state = JSON.parse(raw) as SessionState;
        state.lastSummarisedMessageCount = state.messageCount;
        state.lastSummarisedAt = new Date().toISOString();
        await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
        updated++;
      } catch {
        // skip unreadable state files
      }
    }

    console.log(`[mark-summarised] ${chainId}: zeroed delta across ${updated} session(s)`);
    invalidateScanCache();
    return Response.json({ status: "ok", updated });
  });
}
