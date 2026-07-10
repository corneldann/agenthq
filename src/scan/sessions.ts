import type { SessionState } from '../types.ts';
import { SESSIONS_DIR, SCAN_CACHE_TTL } from '../constants.ts';

// ---------------------------------------------------------------------------
// Module-level cache — NOT exported
// ---------------------------------------------------------------------------

let _sessionsCache: SessionState[] | null = null;
let _sessionsCacheTime = 0;

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export async function scanSessions(
  sessionsDir: string = SESSIONS_DIR,
  workspaceId: string = "default"
): Promise<SessionState[]> {
  if (_sessionsCache && Date.now() - _sessionsCacheTime < SCAN_CACHE_TTL) {
    return _sessionsCache;
  }
  try {
    // New structure: .kiro/sessions/<ts>_<chainId>/State/<hash>.json
    // Also scan _orphan-chains/<chainId>/State/<hash>.json
    const [primary, orphan] = await Promise.all([
      Array.fromAsync(new Bun.Glob("*/State/*.json").scan(sessionsDir)),
      Array.fromAsync(new Bun.Glob("_orphan-chains/*/State/*.json").scan(sessionsDir)),
    ]);
    const filenames = [...primary, ...orphan];
    const sessions: SessionState[] = [];
    for (const filename of filenames) {
      const file = Bun.file(`${sessionsDir}/${filename}`);
      if (!(await file.exists())) continue;
      try {
        const data = await file.json() as SessionState;
        // Populate workspaceId field
        sessions.push({ ...data, workspaceId });
      } catch {
        // skip malformed files
      }
    }
    _sessionsCache = sessions;
    _sessionsCacheTime = Date.now();
    return sessions;
  } catch {
    return [];
  }
}

export function invalidateSessionsCache(): void {
  _sessionsCache = null;
  _sessionsCacheTime = 0;
}
