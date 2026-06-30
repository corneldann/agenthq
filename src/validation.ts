import { existsSync } from "fs";

/**
 * Environment configuration interface for validation functions.
 * Represents the subset of environment variables that require validation.
 */
export interface EnvConfig {
  OUTPUT_DIR: string;
  SESSIONS_DIR: string;
  WORKSPACE_ROOT: string;
  [key: string]: string;
}

/**
 * Identifies required environment variables that are missing or empty.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3**
 *
 * @param env - Environment configuration object
 * @returns Array of variable names that are absent or empty strings
 *
 * @example
 * const missing = findUnconfiguredVars({
 *   OUTPUT_DIR: "",
 *   SESSIONS_DIR: "/valid/path",
 *   WORKSPACE_ROOT: "/another/path"
 * });
 * // Returns: ["OUTPUT_DIR"]
 */
export function findUnconfiguredVars(env: EnvConfig): string[] {
  const required = [
    "OUTPUT_DIR",
    "SESSIONS_DIR",
    "WORKSPACE_ROOT",
  ] as const;

  const missing: string[] = [];
  
  for (const varName of required) {
    const value = env[varName];
    if (value === undefined || value === null || value.trim() === "") {
      missing.push(varName);
    }
  }
  
  return missing;
}

/**
 * Validates that configured path variables point to existing directories.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3**
 *
 * @param env - Environment configuration object
 * @param pathExists - Optional function to check path existence (defaults to fs.existsSync)
 * @returns Array of variable names whose paths do not exist
 *
 * @example
 * const invalid = validateEnvPaths({
 *   OUTPUT_DIR: "/nonexistent/path",
 *   SESSIONS_DIR: "/valid/path",
 *   WORKSPACE_ROOT: "/another/valid"
 * });
 * // Returns: ["OUTPUT_DIR"]
 */
export function validateEnvPaths(
  env: EnvConfig,
  pathExists: (p: string) => boolean = existsSync
): string[] {
  const pathVars = [
    "OUTPUT_DIR",
    "SESSIONS_DIR",
    "WORKSPACE_ROOT",
  ] as const;

  const invalid: string[] = [];

  for (const varName of pathVars) {
    const value = env[varName];
    // Only validate non-empty paths (empty paths are caught by findUnconfiguredVars)
    if (value && value.trim() !== "" && !pathExists(value)) {
      invalid.push(varName);
    }
  }

  return invalid;
}
