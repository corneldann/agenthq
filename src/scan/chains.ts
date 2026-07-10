// scan/chains.ts
// Chain scanning functions extracted from monitor.ts.
// No import-time side effects — no setInterval, no Bun.serve, no top-level I/O.
// Does NOT import from scan/sessions.ts — callers pass sessions in as a parameter.

import path from "node:path";
import type { Chain, SessionState } from '../types.ts';
import { CHAINS_DIR, SPECS_DIR, SCAN_CACHE_TTL } from '../constants.ts';

// ---------------------------------------------------------------------------
// Module-level caches — NOT exported
// ---------------------------------------------------------------------------

let _chainsCache: Chain[] | null = null;
let _chainsCacheTime = 0;

let _specChainsCache: Chain[] | null = null;
let _specChainsCacheTime = 0;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a session belongs to a spec based on its chainId or topic.
 */
function sessionMatchesSpec(sess: SessionState, specName: string, specChainId: string): boolean {
  const cid = (sess.chainId ?? "").toLowerCase();
  const topicLower = (sess.topic ?? "").toLowerCase();

  // Direct spec chain match
  if (cid === `spec-${specName}`) return true;
  if (cid === specChainId) return true;

  // Topic-based match for spec sessions
  if (topicLower.startsWith(`spec: ${specName}`)) return true;
  if (topicLower === specName) return true;

  return false;
}

/**
 * Returns true if a chain (by chainId slug) looks like an "Execute task:" chain.
 */
function isExecuteTaskChain(chainId: string): boolean {
  return chainId.startsWith("execute-task-");
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Returns a stable chainId for a spec, creating the .chain-id file if absent.
 */
export async function getOrCreateSpecChainId(specDir: string): Promise<string> {
  const chainIdFile = path.join(specDir, ".chain-id");
  const file = Bun.file(chainIdFile);
  if (await file.exists()) {
    const id = (await file.text()).trim();
    if (id) return id;
  }
  const newId = crypto.randomUUID();
  await Bun.write(chainIdFile, newId);
  return newId;
}

/**
 * Clears both the chains cache and the spec-chains cache.
 * Called by scan/cache.ts as part of the atomic invalidateScanCache() operation.
 */
export function invalidateChainsCache(): void {
  _chainsCache = null;
  _chainsCacheTime = 0;
  _specChainsCache = null;
  _specChainsCacheTime = 0;
}

/**
 * Scan spec directories and build virtual chains from sessions grouped by spec.
 * allSessions is passed in — no direct dependency on scan/sessions.ts.
 */
export async function scanSpecChains(
  allSessions: SessionState[],
  workspaceId: string = "default"
): Promise<Chain[]> {
  if (_specChainsCache && Date.now() - _specChainsCacheTime < SCAN_CACHE_TTL) {
    return _specChainsCache;
  }

  const specChains: Chain[] = [];

  try {
    const { readdir } = await import("node:fs/promises");
    const specFolders = await readdir(SPECS_DIR, { withFileTypes: true });

    for (const entry of specFolders) {
      if (!entry.isDirectory()) continue;
      const specName = entry.name;
      const specDir = path.join(SPECS_DIR, specName);

      // Skip if not a real spec (needs at minimum a .config.kiro)
      const configFile = Bun.file(path.join(specDir, ".config.kiro"));
      if (!(await configFile.exists())) continue;

      const specChainId = await getOrCreateSpecChainId(specDir);

      // Step 1: Find all "spec-<specName>" sessions
      const specSessions = allSessions.filter(s =>
        sessionMatchesSpec(s, specName, specChainId)
      );
      if (specSessions.length === 0) continue;

      // Step 2: Determine the time window of the spec (first to last session)
      const specDates = specSessions
        .map(s => s.startTime ?? s.lastMessageAt)
        .filter(Boolean)
        .sort();
      const windowStart = new Date(specDates[0]).getTime() - 60_000; // 1 min buffer
      const windowEnd = Date.now(); // include everything up to now

      // Step 3: Include "execute-task-*" sessions within the spec time window
      const executeSessions = allSessions.filter(s => {
        if (!isExecuteTaskChain(s.chainId ?? "")) return false;
        const ts = new Date(s.startTime ?? s.lastMessageAt ?? "").getTime();
        if (!ts) return false;
        return ts >= windowStart && ts <= windowEnd;
      });

      const matched = [...specSessions, ...executeSessions];
      // Deduplicate by workflowHash
      const seen = new Set<string>();
      const unique = matched.filter(s => {
        if (seen.has(s.workflowHash)) return false;
        seen.add(s.workflowHash);
        return true;
      });

      // Sort by startTime ascending to build index
      const sorted = [...unique].sort((a, b) =>
        (a.startTime ?? a.lastMessageAt ?? "").localeCompare(b.startTime ?? b.lastMessageAt ?? "")
      );

      const sessions: Chain["sessions"] = sorted.map((s, i) => ({
        index: i,
        workflowHash: s.workflowHash,
        date: s.startTime ?? s.lastMessageAt,
        messageCount: s.messageCount,
        status: s.status,
      }));

      const totalMessages = sorted.reduce((n, s) => n + (s.messageCount ?? 0), 0);
      const createdAt = sorted[0]?.startTime ?? sorted[0]?.lastMessageAt ?? "";
      const lastActiveAt = sorted[sorted.length - 1]?.lastMessageAt ?? createdAt;

      const latestSession = sorted.reduce<SessionState | undefined>((best, s) =>
        (s.messageCount ?? 0) > (best?.messageCount ?? 0) ? s : best
      , undefined);

      const unsummarisedDelta = sorted.reduce((n, s) => {
        const summarised = s.lastSummarisedMessageCount ?? 0;
        return n + Math.max(0, (s.messageCount ?? 0) - summarised);
      }, 0);

      const statuses = sorted.map(s => s.status);
      let overallStatus = "idle";
      if (statuses.some(s => s === "active"))           overallStatus = "active";
      else if (statuses.some(s => s === "rate-limited")) overallStatus = "rate-limited";
      else if (statuses.every(s => s === "complete"))    overallStatus = "complete";

      // Display name: convert kebab-case to Title Case
      const displayName = specName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      specChains.push({
        chainId: specChainId,
        displayName,
        nextIndex: sessions.length,
        sessions,
        totalMessages,
        createdAt,
        lastActiveAt,
        latestSession,
        unsummarisedDelta,
        overallStatus,
        workflowCount: sorted.length,
        workspaceId,
      });
    }
  } catch (e) {
    console.warn("[spec-chains] scan error:", e);
  }

  _specChainsCache = specChains;
  _specChainsCacheTime = Date.now();
  return specChains;
}

/**
 * Scan chain.json files from disk and return enriched Chain objects.
 * allSessions is passed in to avoid a direct import of scan/sessions.ts.
 * If omitted, sessionsByHash will be empty and session-derived fields will
 * reflect defaults (overallStatus = "idle", unsummarisedDelta = raw messageCount).
 */
export async function scanChains(
  chainsDir: string = CHAINS_DIR,
  allSessions: SessionState[] = [],
  workspaceId: string = "default"
): Promise<Chain[]> {
  if (_chainsCache && Date.now() - _chainsCacheTime < SCAN_CACHE_TTL) {
    return _chainsCache;
  }
  try {
    // Scan both top-level chain folders and _orphan-chains subfolders
    const [primary, orphan] = await Promise.all([
      Array.fromAsync(new Bun.Glob("*/chain.json").scan(chainsDir)),
      Array.fromAsync(new Bun.Glob("_orphan-chains/*/chain.json").scan(chainsDir)),
    ]);
    const filenames = [...primary, ...orphan];
    const sessionsByHash = new Map<string, SessionState>(
      allSessions.map((s) => [s.workflowHash, s])
    );

    const chains: Chain[] = [];
    for (const filename of filenames) {
      const file = Bun.file(`${chainsDir}/${filename}`);
      if (!(await file.exists())) continue;
      try {
        const chain = await file.json() as Chain;

        // Deduplicate chain.sessions by chatSessionId — each workflow file is a
        // State snapshot written after every 2 messages, so one real conversation
        // produces many entries. Keep only the highest-messageCount snapshot per
        // chatSessionId (= the most recent state of that conversation).
        const bestBySession = new Map<string, typeof chain.sessions[0]>();
        for (const entry of chain.sessions) {
          const sess = sessionsByHash.get(entry.workflowHash);
          // Use chatSessionId as the dedup key; fall back to workflowHash so entries
          // without a state file still appear (won't be duplicated since hash is unique)
          const key = sess?.chatSessionId || entry.workflowHash;
          const existing = bestBySession.get(key);
          if (!existing || entry.messageCount > existing.messageCount) {
            bestBySession.set(key, entry);
          }
        }
        // Rebuild as sorted array of deduplicated entries
        const dedupedSessions = Array.from(bestBySession.values())
          .sort((a, b) => a.index - b.index);

        // Find the latest session for this chain (from deduplicated set)
        let latestSession: SessionState | undefined;
        let latestIndex = -1;
        for (const entry of dedupedSessions) {
          const sess = sessionsByHash.get(entry.workflowHash);
          if (sess && entry.index > latestIndex) {
            latestIndex = entry.index;
            latestSession = sess;
          }
        }

        const unsummarisedDelta = (() => {
          // Sum across all deduplicated sessions: messages not yet summarised.
          // For sessions with no state file, assume none are summarised (delta = messageCount).
          let total = 0;
          for (const entry of dedupedSessions) {
            const sess = sessionsByHash.get(entry.workflowHash);
            const summarised = sess ? (sess.lastSummarisedMessageCount ?? 0) : 0;
            const count = sess ? (sess.messageCount ?? entry.messageCount) : entry.messageCount;
            total += Math.max(0, count - summarised);
          }
          return total;
        })();

        // Compute overallStatus from deduplicated sessions
        const statuses = dedupedSessions.map((e) => {
          const s = sessionsByHash.get(e.workflowHash);
          return s ? s.status : "idle";
        });
        let overallStatus = "idle";
        if (statuses.some((s) => s === "rate-limited")) overallStatus = "rate-limited";
        else if (statuses.some((s) => s === "active"))  overallStatus = "active";
        else if (statuses.every((s) => s === "complete")) overallStatus = "complete";

        chains.push({
          ...chain,
          sessions: dedupedSessions,
          latestSession,
          unsummarisedDelta,
          overallStatus,
          workflowCount: chain.sessions.length,
          workspaceId,
        });
      } catch {
        // skip malformed
      }
    }

    // Sort by lastActiveAt descending
    chains.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    // Merge in spec-based virtual chains
    const specChains = await scanSpecChains(allSessions, workspaceId);
    // Build set of session workflowHashes absorbed by spec chains
    const absorbedChainIds = new Set<string>();
    for (const sc of specChains) {
      const absorbedHashes = new Set(sc.sessions.map(s => s.workflowHash));
      // Mark any existing chain whose sessions are all absorbed by this spec chain
      for (const c of chains) {
        if (c.sessions.length > 0 && c.sessions.every(s => absorbedHashes.has(s.workflowHash))) {
          c.specChainId = sc.chainId;
          absorbedChainIds.add(c.chainId);
        }
      }
    }
    // Add spec chains (only if not already present)
    const existingIds = new Set(chains.map(c => c.chainId));
    for (const sc of specChains) {
      if (!existingIds.has(sc.chainId)) chains.push(sc);
    }

    // Re-sort after merge
    chains.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    _chainsCache = chains;
    _chainsCacheTime = Date.now();
    return chains;
  } catch {
    return [];
  }
}
