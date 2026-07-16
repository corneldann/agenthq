// ---------------------------------------------------------------------------
// Workspace Configuration Module
// 
// Defines the WorkspaceConfig interface and ConfigurationLoader for managing
// multiple workspace configurations in AgentHQ.
// ---------------------------------------------------------------------------

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { z } from 'zod';

/**
 * WorkspaceConfig interface defining the structure of a single workspace configuration.
 * 
 * A workspace represents a single Kiro engagement/project with its own sessions,
 * jobs, output, and optional queues.
 */
export interface WorkspaceConfig {
  /** Unique workspace identifier (lowercase alphanumeric and hyphens, 1-50 chars) */
  id: string;
  
  /** Absolute path to job output directory */
  OUTPUT_DIR: string;
  
  /** Absolute path to sessions directory */
  SESSIONS_DIR: string;
  
  /** Absolute path to workspace root (for git operations) */
  WORKSPACE_ROOT: string;
  
  /** Optional: absolute path to chains directory (defaults to SESSIONS_DIR) */
  CHAINS_DIR?: string;
  
  /** Optional: absolute path to specs directory */
  SPECS_DIR?: string;
  
  /** Optional: absolute path to prompt output directory (defaults to OUTPUT_DIR) */
  PROMPT_OUTPUT_DIR?: string;
  
  /** Optional: relative path to crawl queue file (relative to WORKSPACE_ROOT) */
  CRAWL_JOBS_FILE?: string;
  
  /** Optional: relative path to clone queue file (relative to WORKSPACE_ROOT) */
  CLONE_JOBS_FILE?: string;
  
  /** Optional: relative path to build queue file (relative to WORKSPACE_ROOT) */
  BUILD_QUEUE_FILE?: string;
}

/**
 * ConfigurationLoader interface for loading and validating workspace configurations.
 */
export interface ConfigurationLoader {
  /**
   * Load and validate workspace configuration from workspaces.json
   * @returns Array of validated workspace configurations
   * @throws Error if file missing, malformed JSON, duplicate IDs, or >50 workspaces
   */
  loadWorkspaces(): Promise<WorkspaceConfig[]>;
  
  /**
   * Validate a single workspace configuration
   * @param config Workspace configuration to validate
   * @returns true if valid, logs warning and returns false if paths missing
   */
  validateWorkspace(config: WorkspaceConfig): Promise<boolean>;
  
  /**
   * Apply defaults for optional fields
   * @param config Workspace configuration with potential missing optional fields
   * @returns WorkspaceConfig with all fields populated
   */
  applyDefaults(config: WorkspaceConfig): WorkspaceConfig;
}

/**
 * Workspace ID validation regex pattern
 * Allows lowercase alphanumeric characters and hyphens only, 1-50 characters
 */
const WORKSPACE_ID_PATTERN = /^[a-z0-9-]{1,50}$/;

/**
 * Maximum number of workspaces allowed in configuration
 */
const MAX_WORKSPACES = 50;

/**
 * Zod schema for workspace ID validation
 */
const WorkspaceIdSchema = z.string()
  .regex(WORKSPACE_ID_PATTERN, {
    message: "Workspace ID must match pattern ^[a-z0-9-]{1,50}$ (lowercase alphanumeric and hyphens only, 1-50 characters)"
  });

/**
 * Zod schema for individual workspace configuration
 */
const WorkspaceConfigSchema = z.object({
  id: WorkspaceIdSchema,
  OUTPUT_DIR: z.string().min(1, "OUTPUT_DIR must be a non-empty string"),
  SESSIONS_DIR: z.string().min(1, "SESSIONS_DIR must be a non-empty string"),
  WORKSPACE_ROOT: z.string().min(1, "WORKSPACE_ROOT must be a non-empty string"),
  CHAINS_DIR: z.string().optional(),
  SPECS_DIR: z.string().optional(),
  PROMPT_OUTPUT_DIR: z.string().optional(),
  CRAWL_JOBS_FILE: z.string().optional(),
  CLONE_JOBS_FILE: z.string().optional(),
  BUILD_QUEUE_FILE: z.string().optional(),
});

/**
 * Zod schema for the entire workspaces configuration file
 */
const WorkspacesConfigFileSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema)
    .max(MAX_WORKSPACES, `Maximum ${MAX_WORKSPACES} workspaces allowed`)
    .refine((workspaces) => {
      // Check for duplicate workspace IDs (case-sensitive)
      const ids = workspaces.map(w => w.id);
      const uniqueIds = new Set(ids);
      return ids.length === uniqueIds.size;
    }, {
      message: "Duplicate workspace IDs detected. All workspace IDs must be unique (case-sensitive)."
    })
});

/**
 * Default implementation of ConfigurationLoader
 */
export class DefaultConfigurationLoader implements ConfigurationLoader {
  private configPath: string;

  /**
   * Create a new ConfigurationLoader
   * @param configPath Path to workspaces.json (defaults to repository root)
   */
  constructor(configPath?: string) {
    this.configPath = configPath || resolve(process.cwd(), 'workspaces.json');
  }

  /**
   * Load and validate workspace configuration from workspaces.json
   */
  async loadWorkspaces(): Promise<WorkspaceConfig[]> {
    // Check if configuration file exists
    if (!existsSync(this.configPath)) {
      const error = `Configuration file not found: ${this.configPath}`;
      console.error(`ERROR: ${error}`);
      process.exit(1);
    }

    // Read and parse JSON
    let rawData: any;
    try {
      const fileContent = await readFile(this.configPath, 'utf-8');
      rawData = JSON.parse(fileContent);
    } catch (parseError) {
      const error = `Failed to parse configuration file: ${this.configPath}\nJSON parse error: ${parseError}`;
      console.error(`ERROR: ${error}`);
      process.exit(1);
    }

    // Validate using Zod schema
    const parseResult = WorkspacesConfigFileSchema.safeParse(rawData);
    
    if (!parseResult.success) {
      const zodError = parseResult.error;
      const zodErrors = zodError.issues; // Zod uses 'issues' not 'errors'
      
      // Check for duplicate workspace IDs specifically
      const duplicateError = zodErrors.find(err => 
        err.message.includes("Duplicate workspace IDs")
      );
      
      if (duplicateError) {
        // Extract duplicate IDs from the raw data
        const workspaces = rawData?.workspaces || [];
        const seenIds = new Set<string>();
        const duplicates: string[] = [];
        
        for (const workspace of workspaces) {
          if (workspace?.id) {
            if (seenIds.has(workspace.id)) {
              if (!duplicates.includes(workspace.id)) {
                duplicates.push(workspace.id);
              }
            } else {
              seenIds.add(workspace.id);
            }
          }
        }
        
        const error = `Duplicate workspace IDs detected: ${duplicates.join(', ')}`;
        console.error(`ERROR: ${error}`);
        process.exit(1);
      }
      
      // Handle max workspace limit error
      const maxLimitError = zodErrors.find(err => 
        err.message.includes("Maximum") && err.message.includes("workspaces allowed")
      );
      
      if (maxLimitError) {
        const workspaceCount = rawData?.workspaces?.length || 0;
        const error = `Configuration exceeds maximum workspace limit: ${workspaceCount} workspaces (max: ${MAX_WORKSPACES})`;
        console.error(`ERROR: ${error}`);
        process.exit(1);
      }
      
      // Handle other validation errors with detailed information
      const firstError = zodErrors[0];
      const path = firstError.path.join('.');
      const workspaceId = this.extractWorkspaceIdFromPath(rawData, firstError.path);
      
      let error: string;
      if (workspaceId) {
        error = `Workspace "${workspaceId}": ${firstError.message} (at ${path})`;
      } else {
        error = `Configuration validation failed: ${firstError.message} (at ${path})`;
      }
      
      console.error(`ERROR: ${error}`);
      process.exit(1);
    }

    const validatedData = parseResult.data;

    // Track whether we started with an empty array (runtime condition)
    const wasEmptyArray = validatedData.workspaces.length === 0;

    // Apply defaults and validate each workspace
    const validatedWorkspaces: WorkspaceConfig[] = [];
    
    for (const workspace of validatedData.workspaces) {
      const configWithDefaults = this.applyDefaults(workspace);
      const isValid = await this.validateWorkspace(configWithDefaults);
      
      if (isValid) {
        validatedWorkspaces.push(configWithDefaults);
      }
    }

    // Handle zero valid workspaces (Requirement 9.8)
    // Runtime conditions (empty array, all skipped) -> continue with warning
    // Configuration errors were already handled above with exit
    if (validatedWorkspaces.length === 0) {
      if (wasEmptyArray) {
        console.warn(`WARNING: No workspaces defined in configuration file`);
      } else {
        console.warn(`WARNING: All ${validatedData.workspaces.length} workspace(s) skipped due to path validation failures`);
      }
      // Return empty array per Requirement 9.8 - allow application to continue
      return [];
    }

    return validatedWorkspaces;
  }

  /**
   * Extract workspace ID from Zod error path for better error messages
   */
  private extractWorkspaceIdFromPath(data: unknown, path: PropertyKey[]): string | null {
    if (path.length >= 2 && path[0] === 'workspaces' && typeof path[1] === 'number') {
      const workspaceIndex = path[1];
      const d = data as Record<string, unknown>;
      const workspaces = d?.workspaces;
      if (Array.isArray(workspaces)) {
        const workspace = workspaces[workspaceIndex] as Record<string, unknown> | undefined;
        const id = workspace?.id;
        return typeof id === 'string' ? id : null;
      }
    }
    return null;
  }

  /**
   * Validate a single workspace configuration
   * Checks that required directory paths exist on the filesystem
   */
  async validateWorkspace(config: WorkspaceConfig): Promise<boolean> {
    const requiredPaths = [
      { name: 'OUTPUT_DIR', path: config.OUTPUT_DIR },
      { name: 'SESSIONS_DIR', path: config.SESSIONS_DIR },
      { name: 'WORKSPACE_ROOT', path: config.WORKSPACE_ROOT },
    ];

    for (const { name, path } of requiredPaths) {
      if (!existsSync(path)) {
        console.warn(`WARNING: Workspace "${config.id}": required path ${name} does not exist: ${path}`);
        console.warn(`WARNING: Skipping workspace "${config.id}"`);
        return false;
      }
    }

    return true;
  }

  /**
   * Apply defaults for optional fields
   */
  applyDefaults(config: WorkspaceConfig): WorkspaceConfig {
    return {
      ...config,
      CHAINS_DIR: config.CHAINS_DIR || config.SESSIONS_DIR,
      PROMPT_OUTPUT_DIR: config.PROMPT_OUTPUT_DIR || config.OUTPUT_DIR,
      SPECS_DIR: config.SPECS_DIR,
      CRAWL_JOBS_FILE: config.CRAWL_JOBS_FILE,
      CLONE_JOBS_FILE: config.CLONE_JOBS_FILE,
      BUILD_QUEUE_FILE: config.BUILD_QUEUE_FILE,
    };
  }
}

/**
 * Create and return a default configuration loader instance
 */
export function createConfigurationLoader(configPath?: string): ConfigurationLoader {
  return new DefaultConfigurationLoader(configPath);
}
