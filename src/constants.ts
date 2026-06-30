// Constants — all shared path constants and configuration values.
// All file-system paths are sourced from process.env to support workspace portability.

import path from "node:path";
import { config } from "dotenv";

// Load .env before any process.env access (Req 3.1)
config();

/**
 * resolveConstants(env) factory function.
 * Accepts a NodeJS.ProcessEnv object and returns all constants as an object.
 * Exported for testing and property-based verification.
 */
export function resolveConstants(env: NodeJS.ProcessEnv) {
  // Numeric / scalar constants
  const PORT = Number(env.PORT) || 3333;
  const POLL_LOG_MAX = 200;
  const SCAN_CACHE_TTL = 5_000;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  // Path constants — all sourced from process.env with appropriate fallbacks
  // Req 3.2: OUTPUT_DIR
  const OUTPUT_DIR = env.OUTPUT_DIR ?? "";

  // Req 3.3: SESSIONS_DIR
  const SESSIONS_DIR = env.SESSIONS_DIR ?? "";

  // Req 3.4: CHAINS_DIR (fallback to SESSIONS_DIR using || for empty-string handling)
  const CHAINS_DIR = env.CHAINS_DIR || SESSIONS_DIR;

  // Req 3.5: WORKFLOW_DIR (prefer env var, fallback to APPDATA-derived path)
  const WORKFLOW_DIR = env.WORKFLOW_DIR || path.join(
    env.APPDATA ?? "",
    "Kiro", "User", "globalStorage", "kiro.kiroagent",
    "c63f7a0d8b77479ab89f1bc6e7131b78", "414d1636299d2b9e4ce7e17fb11f63e9"
  );

  // Req 3.6: WORKSPACE_ROOT
  const WORKSPACE_ROOT = env.WORKSPACE_ROOT ?? "";

  // Req 3.7: SPECS_DIR
  const SPECS_DIR = env.SPECS_DIR ?? "";

  // Req 3.8: PROMPT_OUTPUT_DIR (fallback to OUTPUT_DIR using || for empty-string handling)
  const PROMPT_OUTPUT_DIR = env.PROMPT_OUTPUT_DIR || OUTPUT_DIR;

  // Req 3.9: CRAWL_JOBS_FILE
  const CRAWL_JOBS_FILE = env.CRAWL_JOBS_FILE ?? "docs/reference/.crawl-queue.json";

  // Req 3.10: CLONE_JOBS_FILE
  const CLONE_JOBS_FILE = env.CLONE_JOBS_FILE ?? "docs/reference/.clone-queue.json";

  // Req 3.11: BUILD_QUEUE_FILE
  const BUILD_QUEUE_FILE = env.BUILD_QUEUE_FILE ?? "docs/reference/.build-queue.json";

  // Additional constants (not in requirements but present in original)
  const KIRO_TOOLS_DIR = env.KIRO_TOOLS_DIR ?? "";

  return {
    PORT,
    POLL_LOG_MAX,
    SCAN_CACHE_TTL,
    SHUTDOWN_TIMEOUT_MS,
    OUTPUT_DIR,
    SESSIONS_DIR,
    CHAINS_DIR,
    WORKFLOW_DIR,
    WORKSPACE_ROOT,
    SPECS_DIR,
    PROMPT_OUTPUT_DIR,
    CRAWL_JOBS_FILE,
    CLONE_JOBS_FILE,
    BUILD_QUEUE_FILE,
    KIRO_TOOLS_DIR,
  };
}

// Module-level exports — call resolveConstants with live process.env
const constants = resolveConstants(process.env);

export const PORT = constants.PORT;
export const POLL_LOG_MAX = constants.POLL_LOG_MAX;
export const SCAN_CACHE_TTL = constants.SCAN_CACHE_TTL;
export const SHUTDOWN_TIMEOUT_MS = constants.SHUTDOWN_TIMEOUT_MS;
export const OUTPUT_DIR = constants.OUTPUT_DIR;
export const SESSIONS_DIR = constants.SESSIONS_DIR;
export const CHAINS_DIR = constants.CHAINS_DIR;
export const WORKFLOW_DIR = constants.WORKFLOW_DIR;
export const WORKSPACE_ROOT = constants.WORKSPACE_ROOT;
export const SPECS_DIR = constants.SPECS_DIR;
export const PROMPT_OUTPUT_DIR = constants.PROMPT_OUTPUT_DIR;
export const CRAWL_JOBS_FILE = constants.CRAWL_JOBS_FILE;
export const CLONE_JOBS_FILE = constants.CLONE_JOBS_FILE;
export const BUILD_QUEUE_FILE = constants.BUILD_QUEUE_FILE;
export const KIRO_TOOLS_DIR = constants.KIRO_TOOLS_DIR;
