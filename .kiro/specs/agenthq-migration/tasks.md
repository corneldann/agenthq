# Implementation Plan: AgentHQ Migration

## Overview

This migration extracts the agenthq/ monitor tooling from the Scottish Water engagement repo into a standalone repository at C:\repos\corneldann\agenthq\. The migration is performed by a PowerShell script (migrate.ps1) with 11 phases (0-10), complemented by TypeScript source code modifications to replace hardcoded paths with environment variables.

The implementation follows a phased approach: (1) create migration script infrastructure with helper functions and template files, (2) implement TypeScript modules for environment-variable-based configuration and startup validation, (3) execute the migration script to create the new repository, (4) verify functionality through smoke tests.

## Tasks

- [x] 1. Create migration script infrastructure
  - [x] 1.1 Create migrate.ps1 script scaffold with phase structure
    - Write PowerShell script at Scottish Water repo root with phase 0-10 structure
    - Define `$DEST`, `$currentPhase` variables and `Fail` helper function
    - Add phase wrapper comments for all 11 phases
    - _Requirements: 1.1, 1.2, 1.8_

  - [x] 1.2 Implement PowerShell helper functions
    - Write `Write-Progress-Step`, `Copy-WithValidation`, `Copy-Spec`, `Read-Template`, `Assert-NoMatch`, `Invoke-WithTimeout` functions
    - Add file count validation logic to `Copy-WithValidation`
    - Add timeout handling to `Invoke-WithTimeout`
    - _Requirements: 1.5, 1.8, 10.4, 10.5, 10.6_

  - [x] 1.3 Create migration template files
    - Create `migrate-templates/` directory at Scottish Water repo root
    - Write `migrate-templates/README.md.template` with AgentHQ readme content
    - Write `migrate-templates/tech-core.md.template` with AgentHQ tech-core content and `{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}` placeholder
    - _Requirements: 2.7, 6.3_

- [x] 2. Implement Phase 0: Pre-flight checks
  - [x] 2.1 Write Phase 0 source path and destination validation
    - Check `agenthq\` directory exists
    - Check `C:\repos\corneldann\agenthq\` does not exist (critical guard for /MIR safety)
    - Report failure with non-zero exit code if checks fail
    - _Requirements: 1.1, 1.2, 1.8_

  - [x] 2.2 Write Phase 0 Git and Bun availability checks
    - Run `git --version` and verify exit code 0
    - Run `bun --version` and verify version ≥1.0.0
    - Report failure with non-zero exit code if unavailable
    - _Requirements: 1.6, 1.7, 1.8_

  - [x] 2.3 Write Phase 0 Scottish Water workspace state check
    - Run `git status --porcelain .kiro/steering/tech-core.md`
    - Fail if uncommitted changes detected
    - _Requirements: 10.1_

  - [x] 2.4 Write Phase 0 long path validation check
    - Scan `agenthq\` for files with paths >240 chars
    - Warn if any found and fail with registry instruction
    - _Requirements: 1.5_

- [x] 3. Implement Phase 0.5: Memory server pre-flight (advisory)
  - [x] 3.1 Write Phase 0.5 best-effort memory server path extraction
    - Check if `@modelcontextprotocol/server-memory` package exists in npm global modules
    - Attempt simple pattern match for `MEMORY_FILE_PATH` or `graph.json` in index.js
    - Set `$MEMORY_SERVER_DEFAULT_PATH_NOTE` variable with advisory extraction result
    - Continue on failure (advisory only)
    - _Requirements: 11.4_

- [x] 4. Implement Phase 1-2: Directory creation and file copy
  - [x] 4.1 Write Phase 1 directory creation logic
    - Create `C:\repos\corneldann\agenthq\` directory
    - Create `workspace\` subdirectory
    - _Requirements: 1.1, 1.2_

  - [x] 4.2 Write Phase 2 file copy with robocopy and validation
    - Call `Copy-WithValidation` helper with exclusion lists (node_modules, .venv, dist, .poll-state.json, .summarise-state.json)
    - Emit progress indicator during copy
    - Validate file count and structural integrity
    - _Requirements: 1.3, 1.4, 1.5_

- [x] 5. Implement Phase 3: Name replacement
  - [x] 5.1 Write Phase 3 package.json name and description replacement
    - Replace `"name": "agenthq"` with `"name": "agenthq"` in package.json
    - Replace description with `"AgentHQ — developer agent monitor and dashboard"`
    - Replace `"agenthq": "src/cli.ts"` with `"agenthq": "src/cli.ts"` in bin field
    - _Requirements: 2.1, 2.2_

  - [x] 5.2 Write Phase 3 dashboard title replacement
    - Replace `<title>AgentHQ Monitor</title>` with `<title>AgentHQ</title>` in src/dashboard/index.html
    - _Requirements: 2.5_

  - [x] 5.3 Write Phase 3 monitor.ts startup log replacement
    - Replace startup log string with `AgentHQ running at http://localhost:`
    - _Requirements: 2.6_

  - [x] 5.4 Write Phase 3 post-replacement verification
    - Run grep for `agenthq|AgentHQ` in `src/` directory
    - Fail if any matches found
    - _Requirements: 2.3, 2.4_

- [x] 6. Create TypeScript validation module
  - [x] 6.1 Create src/validation.ts with pure validation functions
    - Write `findUnconfiguredVars(env)` function returning string[] of missing required vars
    - Write `validateEnvPaths(env, pathExists)` function returning string[] of vars with invalid paths
    - Make functions side-effect-free (no process.exit, no console output)
    - Add injectable `pathExists` parameter for testing
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 7. Checkpoint - Ensure all preliminary tasks complete
  - Ensure all pre-migration infrastructure (script helpers, templates, validation module) is in place before proceeding to constants rewrite.

- [x] 8. Implement Phase 4: Constants module and validation integration
  - [x] 8.1 Write Phase 4 constants.ts rewrite
    - Create backup of original src/constants.ts
    - Rewrite with `resolveConstants(env)` factory function
    - Add `dotenv.config()` call at top
    - Replace all hardcoded paths with `process.env.<VAR> ?? ""` or `process.env.<VAR> || fallback` patterns
    - Export module-level constants from `resolveConstants(process.env)` call
    - Ensure CHAINS_DIR and PROMPT_OUTPUT_DIR use `||` operator for empty-string fallback
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12_

  - [x] 8.2 Write Phase 4 monitor.ts startup validation injection
    - Insert validation block at top of src/monitor.ts before any worker imports
    - Import `findUnconfiguredVars`, `validateEnvPaths` from validation.ts
    - Call both functions and emit warnings for each failure
    - Add WORKFLOW_DIR `%` syntax check
    - Call `process.exit(1)` if any validation fails
    - Move worker imports inside conditional guard using dynamic `import()`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.5_

  - [x] 8.3 Write Phase 4 TypeScript compilation verification
    - Run `node_modules\.bin\tsc.exe --noEmit` in destination
    - Fail if any TypeScript errors reported
    - _Requirements: 3.13_

- [x] 9. Implement Phase 5: Workspace population
  - [x] 9.1 Write Phase 5 steering file generation and copy
    - Read tech-core.md template and substitute `{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}` placeholder
    - Write to `workspace\.kiro\steering\tech-core.md`
    - Copy agent-batching.md and task-concurrency.md from SW workspace
    - _Requirements: 6.3, 6.4, 6.5_

  - [x] 9.2 Write Phase 5 skills directory copy
    - Copy agenthq-dashboard skill and rename from sw-monitor-dashboard
    - Replace all `agenthq/src/dashboard/` with `src/dashboard/` in SKILL.md
    - Replace all `AgentHQ Monitor` with `AgentHQ` in SKILL.md
    - Copy 20 additional skills from SW workspace
    - _Requirements: 6.6, 6.7_

  - [x] 9.3 Write Phase 5 agenthq.code-workspace file creation
    - Create `workspace/agenthq.code-workspace` JSON with single folder entry pointing at `..`
    - _Requirements: 6.2_

  - [x] 9.4 Write Phase 5 powers and memory scaffold
    - Create `workspace\.kiro\powers\agenthq-memory\mcp.json` with memory server config
    - Set `MEMORY_FILE_PATH` to `C:\repos\corneldann\agenthq\workspace\.kiro\memory\graph.json`
    - Add autoApprove array with search_nodes, open_nodes, read_graph
    - Create `workspace\.kiro\memory\.gitkeep`
    - _Requirements: 6.8, 6.9, 11.1_

- [x] 10. Implement Phase 6: Environment file generation
  - [x] 10.1 Write Phase 6 .env.example creation
    - Generate .env.example with all required and optional variables documented
    - Include inline comments for each variable
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 10.2 Write Phase 6 scottishwater.env reference file
    - Create docs/examples/scottishwater.env with Scottish Water concrete paths
    - Add warning comment about %APPDATA% expansion requirement
    - _Requirements: 5.4_

  - [x] 10.3 Write Phase 6 .gitignore creation
    - Create .gitignore excluding node_modules, .venv, dist, __pycache__, *.pyc
    - Exclude .env, .env.local, .env.*.local
    - Add !.env.example after .env exclusion
    - Exclude .poll-state.json, .summarise-state.json
    - Exclude workspace/.kiro/memory/graph.json
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 11. Implement Phase 7-8: README and Git initialization
  - [x] 11.1 Write Phase 7 README.md generation
    - Read README.md template from migrate-templates/
    - Write to destination root
    - _Requirements: 2.7_

  - [x] 11.2 Write Phase 8 Git initialization
    - Run `git init` in destination
    - Run `git add -A`
    - Create initial commit with `feat:` subject line
    - Add remote `https://github.com/corneldann/agenthq.git`
    - _Requirements: 1.6, 1.7, 8.1, 8.2_

  - [x] 11.3 Write Phase 8 Git push with error handling
    - Run `git push -u origin main`
    - Handle rejection if remote contains commits
    - Report error and halt if push fails
    - _Requirements: 8.3, 8.4, 8.5_

- [x] 12. Checkpoint - Verify AgentHQ repository created
  - Ensure all phases 0-8 complete successfully before proceeding to verification phase.

- [x] 13. Implement Phase 9: Functional verification
  - [x] 13.1 Write Phase 9 dependency installation with timeout
    - Run `bun install` using `Invoke-WithTimeout` helper (300s timeout)
    - Emit progress indicator
    - Fail if non-zero exit code
    - _Requirements: 9.1_

  - [x] 13.2 Write Phase 9 TypeScript compilation check
    - Run `node_modules\.bin\tsc.exe --noEmit`
    - Fail if any diagnostic errors reported
    - _Requirements: 9.2_

  - [x] 13.3 Write Phase 9 test suite execution
    - Run `bun test test/`
    - Fail if any tests fail
    - _Requirements: 9.3_

  - [x] 13.4 Write Phase 9 HTTP smoke tests with port conflict handling
    - Detect if port 3333 is in use, fall back to 13333
    - Start monitor server in background process
    - Test GET / returns HTTP 200 with text/html
    - Test SSE endpoint returns HTTP 200 with text/event-stream
    - Test git status endpoint returns HTTP 200 with JSON
    - Add 5s timeout for HTTP requests
    - Stop server process in finally block
    - _Requirements: 9.4, 9.5, 9.6, 9.7_

  - [x] 13.5 Write Phase 9 memory isolation runtime verification
    - Start AgentHQ monitor with valid .env
    - Write test entity to memory MCP server with 2s timeout
    - Verify graph.json created at AgentHQ path
    - Verify Scottish Water memory graph path differs (case-insensitive comparison)
    - Clean up test entity and stop server in finally block
    - _Requirements: 11.2, 11.3_

- [x] 14. Implement Phase 10: Scottish Water handover
  - [x] 14.1 Write Phase 10 pre-handover verification
    - Verify Phase 9 completed successfully
    - Check git status for uncommitted changes to tech-core.md
    - Run grep pre-verification for sw-monitor-dashboard and agenthq/ patterns
    - Prompt user confirmation if pre-verification warns
    - _Requirements: 10.1_

  - [x] 14.2 Write Phase 10 tech-core.md rewrite
    - Read current content of .kiro/steering/tech-core.md in SW workspace
    - Replace sw-monitor-dashboard with agenthq-dashboard
    - Replace agenthq/src/dashboard/ with src/dashboard/
    - Remove remaining agenthq/ path references
    - Write back to file
    - Run `Assert-NoMatch` verification
    - _Requirements: 10.1_

  - [x] 14.3 Write Phase 10 spec migration with file-count verification
    - Call `Copy-Spec` helper for monitor-dashboard-redesign
    - Call `Copy-Spec` helper for monitor-server-split
    - Verify file counts match between source and destination
    - Halt entire handover if verification fails
    - Remove source directories only after verification
    - _Requirements: 10.4, 10.5, 10.6_

  - [x] 14.4 Write Phase 10 agenthq/ removal and commit
    - Remove agenthq/ directory from SW workspace
    - Run `git add -A`
    - Commit with subject `chore(agenthq): remove agenthq/ — extracted to corneldann/agenthq`
    - _Requirements: 10.2, 10.3, 10.7_

- [x] 15. Final verification and documentation
  - [x] 15.1 Run end-to-end migration test
    - Execute migrate.ps1 in clean test environment
    - Verify all 11 phases complete without errors
    - Verify AgentHQ repo structure matches design
    - Verify Scottish Water workspace handover complete
    - _Requirements: 1.8, 8.1, 9.1, 9.2, 9.3, 10.7_

  - [x] 15.2 Verify .env.example works as documented
    - Copy .env.example to .env
    - Fill in valid paths
    - Start monitor server
    - Verify startup succeeds without warnings
    - _Requirements: 5.5_

## Notes

- Tasks are organized into sequential phases matching the migration script's 11-phase structure (0-10)
- Phase 0-8 create the AgentHQ repository, Phase 9 verifies functionality, Phase 10 updates Scottish Water workspace
- TypeScript modules (validation.ts, constants.ts rewrite, monitor.ts startup injection) are created alongside PowerShell script phases
- All file copy operations include validation (file count, structural integrity)
- All grep-based verifications use `Assert-NoMatch` helper to ensure clean state
- Checkpoints at task 7 and 12 ensure prerequisites complete before dependent phases
- Memory isolation verification in Phase 9 confirms bidirectional isolation between AgentHQ and Scottish Water knowledge graphs

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2", "2.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.1"] },
    { "id": 3, "tasks": ["4.1", "8.1"] },
    { "id": 4, "tasks": ["4.2", "5.1", "8.2"] },
    { "id": 5, "tasks": ["5.2", "5.3", "8.3"] },
    { "id": 6, "tasks": ["5.4", "9.1", "9.2"] },
    { "id": 7, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 8, "tasks": ["10.2", "10.3", "11.1"] },
    { "id": 9, "tasks": ["11.2"] },
    { "id": 10, "tasks": ["11.3", "13.1"] },
    { "id": 11, "tasks": ["13.2", "13.3"] },
    { "id": 12, "tasks": ["13.4", "13.5"] },
    { "id": 13, "tasks": ["14.1"] },
    { "id": 14, "tasks": ["14.2", "14.3"] },
    { "id": 15, "tasks": ["14.4"] },
    { "id": 16, "tasks": ["15.1", "15.2"] }
  ]
}
```
