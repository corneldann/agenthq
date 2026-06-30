// routes/chain-management.ts
// Handlers for chain visibility, naming, and folder management.
// POST /hide-chain/:id, POST /unhide-chain/:id,
// POST /update-chain-name, GET|POST /chain-folder/:id

import path from "node:path";
import type { Router } from '../router.ts';
import type { Chain } from '../types.ts';
import { WORKSPACE_ROOT } from '../constants.ts';
import { invalidateScanCache } from '../scan/cache.ts';

// ---------------------------------------------------------------------------
// Private helper — resolve the timestamp folder path for a chainId
// ---------------------------------------------------------------------------
async function resolveChainFolder(chainId: string): Promise<string | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const sessionsBase = path.join(WORKSPACE_ROOT, ".kiro", "sessions");
    const dirs = await readdir(sessionsBase);
    const match = dirs.find(
      d => d.endsWith(`_${chainId}`) && /^\d{4}-\d{2}-\d{2}/.test(d)
    );
    if (match) return path.join(sessionsBase, match);
    // Also check _orphan-chains
    const orphan = path.join(sessionsBase, "_orphan-chains", chainId);
    if (await Bun.file(path.join(orphan, "chain.json")).exists()) return orphan;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Patch helper — read chain.json, apply patch, write back, invalidate cache
// ---------------------------------------------------------------------------
async function patchChainJson(
  chainId: string,
  patch: Partial<Chain & { hidden?: boolean; folder?: string }>,
): Promise<{ ok: true; folder: string } | { ok: false; status: number; message: string }> {
  const folder = await resolveChainFolder(chainId);
  if (!folder) {
    return { ok: false, status: 404, message: "Chain folder not found" };
  }
  const chainJsonPath = path.join(folder, "chain.json");
  const file = Bun.file(chainJsonPath);
  if (!(await file.exists())) {
    return { ok: false, status: 404, message: "chain.json not found" };
  }
  const existing = await file.json() as Record<string, unknown>;
  const updated = { ...existing, ...patch };
  await Bun.write(chainJsonPath, JSON.stringify(updated, null, 4));
  invalidateScanCache();
  return { ok: true, folder };
}

export function register(router: Router): void {
  // ------------------------------------------------------------------
  // POST /hide-chain/:id — set hidden:true on chain.json
  // ------------------------------------------------------------------
  router.post('/hide-chain/:id', async (_req, params) => {
    const chainId = decodeURIComponent(params.id);
    const result = await patchChainJson(chainId, { hidden: true } as Partial<Chain & { hidden: boolean }>);
    if (!result.ok) {
      return Response.json({ status: "error", message: result.message }, { status: result.status });
    }
    return Response.json({ status: "ok", chainId });
  });

  // ------------------------------------------------------------------
  // POST /unhide-chain/:id — set hidden:false on chain.json
  // ------------------------------------------------------------------
  router.post('/unhide-chain/:id', async (_req, params) => {
    const chainId = decodeURIComponent(params.id);
    const result = await patchChainJson(chainId, { hidden: false } as Partial<Chain & { hidden: boolean }>);
    if (!result.ok) {
      return Response.json({ status: "error", message: result.message }, { status: result.status });
    }
    return Response.json({ status: "ok", chainId });
  });

  // ------------------------------------------------------------------
  // POST /update-chain-name — update displayName in chain.json
  // Body: { chainId: string, name: string }
  // ------------------------------------------------------------------
  router.post('/update-chain-name', async (req, _params) => {
    let body: { chainId?: string; name?: string };
    try {
      body = await req.json() as { chainId?: string; name?: string };
    } catch {
      return Response.json({ status: "error", message: "Invalid JSON body" }, { status: 400 });
    }
    const { chainId, name } = body;
    if (!chainId || typeof chainId !== "string") {
      return Response.json({ status: "error", message: "chainId is required" }, { status: 400 });
    }
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return Response.json({ status: "error", message: "name is required" }, { status: 400 });
    }
    const result = await patchChainJson(chainId, { displayName: name.trim() } as Partial<Chain>);
    if (!result.ok) {
      return Response.json({ status: "error", message: result.message }, { status: result.status });
    }
    return Response.json({ status: "ok", chainId, name: name.trim() });
  });

  // ------------------------------------------------------------------
  // GET /chain-folder/:id — return the current folder assignment for a chain
  // ------------------------------------------------------------------
  router.get('/chain-folder/:id', async (_req, params) => {
    const chainId = decodeURIComponent(params.id);
    const folder = await resolveChainFolder(chainId);
    if (!folder) {
      return Response.json({ status: "error", message: "Chain folder not found" }, { status: 404 });
    }
    const chainJsonPath = path.join(folder, "chain.json");
    const file = Bun.file(chainJsonPath);
    if (!(await file.exists())) {
      return Response.json({ status: "error", message: "chain.json not found" }, { status: 404 });
    }
    const existing = await file.json() as Record<string, unknown>;
    return Response.json({
      status: "ok",
      chainId,
      folder: (existing.folder as string | undefined) ?? null,
    });
  });

  // ------------------------------------------------------------------
  // POST /chain-folder/:id — set folder assignment in chain.json
  // Body: { folder: string | null }
  // ------------------------------------------------------------------
  router.post('/chain-folder/:id', async (req, params) => {
    const chainId = decodeURIComponent(params.id);
    let body: { folder?: string | null };
    try {
      body = await req.json() as { folder?: string | null };
    } catch {
      return Response.json({ status: "error", message: "Invalid JSON body" }, { status: 400 });
    }
    const folderValue = body.folder ?? null;
    if (folderValue !== null && (typeof folderValue !== "string" || folderValue.trim().length === 0)) {
      return Response.json({ status: "error", message: "folder must be a non-empty string or null" }, { status: 400 });
    }
    const result = await patchChainJson(
      chainId,
      { folder: folderValue ?? undefined } as Partial<Chain & { folder?: string }>,
    );
    if (!result.ok) {
      return Response.json({ status: "error", message: result.message }, { status: result.status });
    }
    return Response.json({ status: "ok", chainId, folder: folderValue });
  });
}
