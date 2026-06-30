// scan/helpers.ts
// Pure string-parsing helpers extracted from monitor.ts.
// No I/O, no HTTP server dependency, no import-time side effects.

/**
 * Extract the value of an HTML comment header embedded in a markdown file.
 * e.g.  <!-- type: analysis -->  → "analysis"
 * Returns "unknown" if the header is not present.
 */
export function extractHeader(md: string, headerName: string): string {
  const match = md.match(new RegExp(`<!--\\s*${headerName}:\\s*(.+?)\\s*-->`));
  return match ? match[1].trim() : "unknown";
}

/**
 * Determine the run status of a job from its markdown content, optional log
 * content, and the agent name extracted from the markdown header.
 */
export function detectStatus(
  md: string,
  log: string | null,
  agent: string
): "running" | "done" | "reported" | "error" {
  if (
    log &&
    (log.includes("Error:") ||
      log.includes("Response failed") ||
      /exit code [^0]/.test(log))
  ) {
    return "error";
  }
  // git-commit-worker completion — check first (most specific, beats agenthq log marker)
  if (md.includes("## Result") && md.includes("- Commit:")) {
    return "done";
  }
  if (
    md.includes("[agenthq] done in") ||
    md.includes("[goose_recipe_worker] Done") ||
    md.includes("Summary written to ")
  ) {
    return "done";
  }
  // Agent finished (log has done marker) but wrote findings as chat, not as a file
  if (log && log.includes("[agenthq] done in")) {
    return "reported";
  }
  // Files written directly by kiro (not via agenthq) are always done
  if (agent === "kiro") {
    return "done";
  }
  return "running";
}

/**
 * Extract the "[agenthq] done in …" or "[goose_recipe_worker] Done…" line
 * from a markdown job file. Returns an empty string when not present.
 */
export function extractAgentDone(md: string): string {
  const match = md.match(/\[agenthq\] done in .+$/m);
  if (match) return match[0];
  const match2 = md.match(/\[goose_recipe_worker\] Done.*$/m);
  return match2 ? match2[0] : "";
}

/**
 * Parse a human-readable timestamp from a job filename.
 * Expected pattern: YYYY-MM-DD-HHmm-<name>.md
 * Returns "unknown" if the pattern is not matched.
 */
export function parseTimestamp(filename: string): string {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  if (!m) return "unknown";
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/**
 * Extract the human-readable name portion of a job filename by stripping the
 * leading date/time prefix and the trailing `.md` extension.
 */
export function extractName(filename: string): string {
  const noExt = filename.replace(/\.md$/, "");
  const m = noExt.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)$/);
  return m ? m[1] : noExt;
}

/**
 * Extract a session chainId from a file-system source path.
 *
 * Matches the following path patterns (in priority order):
 *   1. …/sessions/YYYY-MM-DD_<chainId>/…   → returns <chainId>
 *   2. …/sessions/<chainId>/…              → returns <chainId>
 *   3. …/_orphan-chains/<chainId>           → returns <chainId>
 *
 * Returns an empty string when no pattern matches.
 */
export function extractSessionChainId(sourcePath: string): string {
  // Match timestamp_chainId folder pattern: sessions/2026-06-22_chainId/
  const m = sourcePath.match(/[/\\]sessions[/\\]\d{4}-\d{2}-\d{2}[^/\\]*_([^/\\]+)[/\\]/);
  if (m) return m[1];
  // Match bare chainId folder pattern: sessions/chainId/
  const m3 = sourcePath.match(/[/\\]sessions[/\\]([^/\\]+)[/\\]/);
  if (m3) return m3[1];
  // Fallback: look for _orphan-chains/chainId
  const m2 = sourcePath.match(/_orphan-chains[/\\]([^/\\]+)/);
  if (m2) return m2[1];
  return "";
}
