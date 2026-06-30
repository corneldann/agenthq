// routes/resume.ts — Resume, handoff, and view-chain handlers.

import path from "node:path";
import type { Router } from '../router.ts';
import { WORKSPACE_ROOT, CHAINS_DIR } from '../constants.ts';
import { scanChains } from '../scan/chains.ts';
import { scanSessions } from '../scan/sessions.ts';

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
  // POST /resume/:chainId — generate a resume handoff session file
  // ------------------------------------------------------------------
  router.post('/resume/:chainId', async (_req, params) => {
    const chainId = decodeURIComponent(params.chainId);
    const chains = await scanChains(CHAINS_DIR, await scanSessions());
    const chain = chains.find((c) => c.chainId === chainId);
    if (!chain) {
      return Response.json({ status: "not-found" }, { status: 404 });
    }
    const sess = chain.latestSession;

    // Read chain.md (last 200 lines)
    let chainMdText = "";
    const folder = await chainFolder(chainId);
    const chainMdPath = folder ? path.join(folder, "chain.md") : null;
    if (chainMdPath) {
      const chainMdFile = Bun.file(chainMdPath);
      if (await chainMdFile.exists()) {
        const full = await chainMdFile.text();
        chainMdText = full.split("\n").slice(-200).join("\n");
      }
    }

    // Read latest summary (last 100 lines)
    let summaryText = "";
    if (sess?.summaryFile) {
      const summFile = Bun.file(path.join(WORKSPACE_ROOT, sess.summaryFile));
      if (await summFile.exists()) {
        const full = await summFile.text();
        summaryText = full.split("\n").slice(-100).join("\n");
      }
    }

    const nextIndex = chain.nextIndex;
    const title = `${chain.displayName} ${nextIndex}`;
    const lastMsg = sess?.lastUserMessage ?? "";

    const firstMessage =
      `${title}\n\nCHAIN_ID: ${chainId}\n\n` +
      (chainMdText ? `${chainMdText}\n\n` : "") +
      (summaryText ? `**Last session summary:**\n${summaryText}\n\n` : "") +
      (lastMsg ? `**Last message:** ${lastMsg}\n\n` : "") +
      `Continue from where we left off.`;

    const now = new Date();
    const isoTs = now.toISOString();
    const jsonlFilename = `${isoTs.replace(/[:.]/g, "-")}.jsonl`;
    const jsonlPath = path.join(WORKSPACE_ROOT, ".sessions", jsonlFilename);
    const jsonlLine = JSON.stringify({
      timestamp: isoTs,
      message: { role: "user", content: firstMessage },
    });

    const utf8 = new TextEncoder();
    await Bun.write(jsonlPath, utf8.encode(jsonlLine + "\n"));

    // Write .kiro/handoff/latest.md
    const handoffPath = path.join(WORKSPACE_ROOT, ".kiro", "handoff", "latest.md");
    await Bun.write(handoffPath, utf8.encode(firstMessage));

    return Response.json({ status: "ready", sessionFile: jsonlFilename, title });
  });

  // ------------------------------------------------------------------
  // POST /handoff — write supplied content to .kiro/handoff/latest.md
  // ------------------------------------------------------------------
  router.post('/handoff', async (req, _params) => {
    try {
      const body = (await req.json()) as { content?: string };
      const content = typeof body?.content === "string" ? body.content : "";
      const handoffPath = path.join(WORKSPACE_ROOT, ".kiro", "handoff", "latest.md");
      await Bun.write(handoffPath, new TextEncoder().encode(content));
      return Response.json({ status: "ok" });
    } catch {
      return Response.json({ status: "error", message: "Invalid request body" }, { status: 400 });
    }
  });

  // ------------------------------------------------------------------
  // GET /view-chain/:chainId — serve chain-summary.md (falls back to chain.json)
  // ------------------------------------------------------------------
  router.get('/view-chain/:chainId', async (_req, params) => {
    const chainId = decodeURIComponent(params.chainId);
    const folder = await chainFolder(chainId);
    if (!folder) return new Response("Chain not found", { status: 404 });

    // Try chain-summary.md first, then chain.md (legacy)
    for (const name of ["chain-summary.md", "chain.md"]) {
      const p = path.join(folder, name);
      const f = Bun.file(p);
      if (await f.exists()) {
        return new Response(await f.text(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    // Nothing found — show chain.json as fallback
    const chainJson = Bun.file(path.join(folder, "chain.json"));
    if (await chainJson.exists()) {
      return new Response(await chainJson.text(), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response(
      "No summary available for this chain yet. Click Summarise to generate one.",
      { status: 404 }
    );
  });

}
