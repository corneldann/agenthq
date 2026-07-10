# Requirements Document

## Introduction

AgentHQ is a general-purpose developer agent monitor and dashboard, currently living
inside the Scottish Water engagement repo as `agenthq/`. It has no logical dependency
on the Scottish Water project — it monitors any Kiro workspace. This migration extracts
`agenthq/` into a standalone, reusable repo at `C:\repos\corneldann\agenthq\` and
publishes it as `corneldann/agenthq` on GitHub.

The core deliverable is a clean, engagement-agnostic repository where every previously
hardcoded Scottish Water path is replaced by environment-variable-based configuration,
all `sw-*` naming is replaced with `agenthq`, and the Kiro workspace configuration
(steering, skills, powers) is version-controlled inside the repo under `workspace/`.

The Scottish Water workspace is then updated to run AgentHQ from its new location, and
the `agenthq/` directory is removed from the Scottish Water repo.

---

## Glossary

- **AgentHQ**: The standalone developer agent monitor and dashboard extracted from `agenthq/`.
- **Migration_Script**: A PowerShell script or sequence of commands that performs file copy, git init, and rename operations.
- **Constants_Module**: The file `src/constants.ts` in the AgentHQ repo that exports all path and configuration constants.
- **Env_File**: The `.env` file at the root of the AgentHQ repo, gitignored, containing deployment-specific path values.
- **Env_Example**: The `.env.example` file committed to the repo documenting all required and optional environment variables.
- **Scottish_Water_Path**: Any absolute or relative path referencing a directory inside the Scottish Water engagement repo.
- **Workspace_Dir**: The `workspace/` directory at the AgentHQ repo root, tracked in git, containing the Kiro workspace config.
- **Kiro_Config**: The `.kiro/` directory tree inside `Workspace_Dir` holding steering files, skills, powers, and specs.
- **Dashboard_SPA**: The TypeScript single-page application under `src/dashboard/` compiled to `dist/` by Bun.
- **Monitor_Server**: The Bun HTTP server started by `bun src/monitor.ts`, serving the Dashboard_SPA and API routes.
- **sw-agent_Dir**: The directory `agenthq/` inside the Scottish Water repo that is the source of the migration.

---

## Requirements

### Requirement 1: Repository Initialisation

**User Story:** As a developer, I want the AgentHQ repo created with all source files
copied from `agenthq/`, so that I have an isolated working copy to migrate.

#### Acceptance Criteria

1. IF the directory `C:\repos\corneldann\agenthq\` does not exist, THEN THE Migration_Script SHALL create it before proceeding.
2. IF the directory `C:\repos\corneldann\agenthq\workspace\` does not exist, THEN THE Migration_Script SHALL create it before proceeding.
3. WHEN copying files from `agenthq\` to `C:\repos\corneldann\agenthq\`, THE Migration_Script SHALL preserve the full directory structure of the source.
4. WHEN copying files, THE Migration_Script SHALL exclude `node_modules\`, `.venv\`, `dist\`, `.poll-state.json`, and `.summarise-state.json`; IF any exclusion fails or an excluded item is copied, THE Migration_Script SHALL halt the copy operation immediately and report the failure before exiting with a non-zero exit code.
5. WHEN the copy completes, every non-excluded file and directory from `agenthq\` SHALL exist at the corresponding path under `C:\repos\corneldann\agenthq\`; WHEN the copy completes, THE Migration_Script SHALL perform additional validation — including a file count comparison between source and destination — before marking the copy as complete.
6. WHEN the copy completes, THE Migration_Script SHALL initialise a new git repository at `C:\repos\corneldann\agenthq\` with `git init`.
7. WHEN `git init` completes, THE Migration_Script SHALL add `https://github.com/corneldann/agenthq.git` as the `origin` remote.
8. IF any step in the Migration_Script fails — including file system operations, exclusion enforcement, `git init`, and remote setup — THE Migration_Script SHALL halt immediately and report the failing step before exiting with a non-zero exit code; the exit code SHALL be non-zero regardless of whether the halt mechanism itself exits cleanly.

---

### Requirement 2: Name Replacement (sw-* → agenthq)

**User Story:** As a developer, I want all `agenthq` / `AgentHQ` branding replaced
with `agenthq` / `AgentHQ`, so that the repo is engagement-neutral.

#### Acceptance Criteria

1. IF the migration has completed, THE AgentHQ repo's `package.json` SHALL contain `"name": "agenthq"`.
2. IF the migration has completed, THE AgentHQ repo's `package.json` `description` field SHALL equal `"AgentHQ — developer agent monitor and dashboard"`.
3. AT ALL TIMES, no file under `src/` SHALL contain the literal string `AgentHQ` or `agenthq` in user-visible strings, log output, or comments; this prohibition is unconditional and applies both during and after migration.
4. IF the migration has completed, no file or directory name under `src/` SHALL contain the substring `agenthq`.
5. IF the migration has completed, THE Dashboard_SPA `<title>` element SHALL read `AgentHQ`.
6. WHEN the Monitor_Server starts, THE Monitor_Server SHALL log a message containing `"AgentHQ running at http://localhost:"` followed by the port number the server is bound to.
7. IF the migration has completed, THE AgentHQ repo SHALL contain a `README.md` with at minimum three sections: quick-start instructions, configuration reference, and build steps.

---

### Requirement 3: Environment-Variable-Based Path Configuration

**User Story:** As a developer on any engagement, I want all workspace paths read from
`.env` rather than hardcoded, so that I can point AgentHQ at any Kiro workspace by
editing a single file.

#### Acceptance Criteria

1. THE Constants_Module SHALL invoke the `.env` file loader before any `process.env` read, so that variables defined in `.env` are available without the caller pre-loading the environment.
2. THE Constants_Module SHALL export `OUTPUT_DIR` as `process.env.OUTPUT_DIR ?? ""`.
3. THE Constants_Module SHALL export `SESSIONS_DIR` as `process.env.SESSIONS_DIR ?? ""`.
4. THE Constants_Module SHALL export `CHAINS_DIR` as `process.env.CHAINS_DIR ?? SESSIONS_DIR`, falling back to the value of `SESSIONS_DIR` when the variable is absent or empty; when both are absent, the resolved value SHALL be an empty string.
5. THE Constants_Module SHALL export `WORKFLOW_DIR` preferring `process.env.WORKFLOW_DIR` when set to a non-empty string, falling back to an APPDATA-derived path (`path.join(process.env.APPDATA, "Kiro", "User", "globalStorage", ...)`) when the env var is absent or empty; if `process.env.APPDATA` is also absent, the fallback SHALL resolve to an empty-string prefix.
6. THE Constants_Module SHALL export `WORKSPACE_ROOT` as `process.env.WORKSPACE_ROOT ?? ""`.
7. THE Constants_Module SHALL export `SPECS_DIR` as `process.env.SPECS_DIR ?? ""`.
8. THE Constants_Module SHALL export `PROMPT_OUTPUT_DIR` as `process.env.PROMPT_OUTPUT_DIR ?? OUTPUT_DIR`, falling back to `OUTPUT_DIR` when the variable is absent or empty; when both are absent, the resolved value SHALL be an empty string.
9. THE Constants_Module SHALL export `CRAWL_JOBS_FILE` as `process.env.CRAWL_JOBS_FILE ?? "docs/reference/.crawl-queue.json"`.
10. THE Constants_Module SHALL export `CLONE_JOBS_FILE` as `process.env.CLONE_JOBS_FILE ?? "docs/reference/.clone-queue.json"`.
11. THE Constants_Module SHALL export `BUILD_QUEUE_FILE` as `process.env.BUILD_QUEUE_FILE ?? "docs/reference/.build-queue.json"`.
12. THE Constants_Module SHALL NOT contain any string literal that is a hardcoded absolute or relative file-system path not sourced from `process.env`; this prohibition applies to both absolute paths (e.g. `C:\repos\...`) and relative paths (e.g. `docs/reference/...`) used as literal default values outside of `process.env` fallback expressions; IF any hardcoded path is detected during the build, THE build SHALL fail immediately before producing any output.
13. WHEN `node_modules\.bin\tsc.exe --noEmit` is run in the AgentHQ repo root after the Constants_Module change, THE TypeScript_Compiler SHALL report zero errors; this criterion SHALL fail if any TypeScript error is reported, regardless of whether those errors existed before the Constants_Module changes.

---

### Requirement 4: Startup Path Validation

**User Story:** As a developer, I want the Monitor_Server to warn me at startup if
required paths are not configured, so that I know immediately when `.env` is incomplete.

#### Acceptance Criteria

1. WHEN `OUTPUT_DIR` is absent from the environment or set to an empty string at startup, THE Monitor_Server SHALL emit a WARNING-level log entry that identifies `OUTPUT_DIR` as unconfigured, before reaching a request-accepting state.
2. WHEN `SESSIONS_DIR` is absent from the environment or set to an empty string at startup, THE Monitor_Server SHALL emit a WARNING-level log entry that identifies `SESSIONS_DIR` as unconfigured, before reaching a request-accepting state.
3. WHEN `WORKSPACE_ROOT` is absent from the environment or set to an empty string at startup, THE Monitor_Server SHALL emit a WARNING-level log entry that identifies `WORKSPACE_ROOT` as unconfigured, before reaching a request-accepting state.
4. IF one or more of `OUTPUT_DIR`, `SESSIONS_DIR`, or `WORKSPACE_ROOT` are absent or empty at startup, THEN THE Monitor_Server SHALL emit all applicable WARNING-level log entries (per criteria 1–3) before terminating, and SHALL then terminate with a non-zero exit code before reaching a request-accepting state; warnings SHALL be emitted for every unconfigured variable before the process exits.
5. WHEN `OUTPUT_DIR`, `SESSIONS_DIR`, and `WORKSPACE_ROOT` are all set to non-empty strings at startup, THE Monitor_Server SHALL start without emitting any WARNING-level log entries referencing those three variables.

---

### Requirement 5: Env_Example Documentation

**User Story:** As a developer onboarding to AgentHQ, I want a committed `.env.example`
file that documents every configurable variable, so that I can configure a new engagement
in minutes without reading source code.

#### Acceptance Criteria

1. THE AgentHQ repo SHALL contain a committed `.env.example` file at the repo root documenting all environment variables consumed by the Constants_Module.
2. THE Env_Example SHALL include inline comments describing the purpose of each variable.
3. THE Env_Example SHALL document all of: `PORT`, `OUTPUT_DIR`, `SESSIONS_DIR`, `CHAINS_DIR`, `WORKFLOW_DIR`, `WORKSPACE_ROOT`, `SPECS_DIR`, `PROMPT_OUTPUT_DIR`, `CRAWL_JOBS_FILE`, `CLONE_JOBS_FILE`, `BUILD_QUEUE_FILE`, and `KIRO_TOOLS_DIR`.
4. THE AgentHQ repo SHALL contain `docs/examples/scottishwater.env` documenting the specific path values used for the Scottish Water engagement, for reference.
5. WHEN a new `.env` file is created by copying `.env.example` and filling in valid paths, THE Monitor_Server SHALL start with those paths without requiring any code changes; WHEN the Monitor_Server starts, it SHALL validate that all paths declared in the `.env` file are valid and compatible before accepting connections; IF no valid `.env` file exists, IF the `.env` file contains invalid paths, or IF the paths in the `.env` file would require code changes to function, THE Monitor_Server SHALL refuse to start and exit with a non-zero exit code.

---

### Requirement 6: Kiro Workspace Configuration

**User Story:** As a developer, I want the Kiro workspace config (steering, skills,
powers) committed inside the AgentHQ repo under `workspace/`, so that the configuration
is version-controlled and portable across machines.

#### Acceptance Criteria

1. THE AgentHQ repo SHALL contain a `workspace/` directory committed to git.
2. THE Workspace_Dir SHALL contain an `agenthq.code-workspace` file with a single `folders` entry pointing at `".."` (the repo root), so that opening the workspace file in Kiro/VSCode loads the full repo.
3. THE Workspace_Dir SHALL contain `workspace/.kiro/steering/tech-core.md` with at minimum four sections: tech stack, module structure, key commands, and a skills index table mapping skill name to activation condition.
4. THE Workspace_Dir SHALL contain `workspace/.kiro/steering/agent-batching.md` containing the rate-limit batching rules copied from the Scottish Water workspace.
5. THE Workspace_Dir SHALL contain `workspace/.kiro/steering/task-concurrency.md` containing the sequential subagent execution rules copied from the Scottish Water workspace.
6. THE Workspace_Dir SHALL contain `workspace/.kiro/skills/agenthq-dashboard/SKILL.md` where: the front-matter `name:` field equals `agenthq-dashboard`; the front-matter `description:` field contains no `sw-monitor-dashboard` or `agenthq/` strings; all occurrences of `agenthq/src/dashboard/` in the skill body are replaced with `src/dashboard/`; and all occurrences of `AgentHQ Monitor` are replaced with `AgentHQ`.
7. THE Workspace_Dir SHALL contain a skill directory for each of the following: `accelint-ts-best-practices`, `accelint-ts-testing`, `accelint-ts-performance`, `accelint-ts-documentation`, `typescript-advanced-types`, `javascript-testing-patterns`, `modern-javascript-patterns`, `debugging-strategies`, `error-handling-patterns`, `frontend-design`, `design-system-patterns`, `interaction-design`, `responsive-design`, `ux-design-systems`, `visual-design-foundations`, `accessibility`, `improve-codebase-architecture`, `diagnose`, `best-practices`, `memory-consolidation`.
8. THE Workspace_Dir SHALL contain `workspace/.kiro/powers/agenthq-memory/mcp.json` with a single MCP server entry named `memory`, where: the `env.MEMORY_FILE_PATH` value is the absolute path `C:\repos\corneldann\agenthq\workspace\.kiro\memory\graph.json`; and the `autoApprove` array contains `search_nodes`, `open_nodes`, and `read_graph`.
9. THE Workspace_Dir SHALL contain `workspace/.kiro/memory/` tracked via a `.gitkeep` file; the `workspace/.kiro/memory/graph.json` file SHALL be listed in `.gitignore`.
10. THE Workspace_Dir SHALL NOT contain any MCP server configuration referencing Oracle, pbixray, or Power BI endpoints.

---

### Requirement 7: Project Hygiene and .gitignore

**User Story:** As a developer, I want the AgentHQ repo to have a clean `.gitignore`
so that build artefacts, runtime state, secrets, and the memory graph are never
accidentally committed.

#### Acceptance Criteria

1. THE AgentHQ repo SHALL contain a `.gitignore` file that excludes `node_modules/`, `.venv/`, `dist/`, `__pycache__/`, and `*.pyc`.
2. THE AgentHQ `.gitignore` SHALL exclude `.env`, `.env.local`, `.env.*.local` so that engagement-specific secrets and paths are never committed.
3. THE AgentHQ `.gitignore` SHALL exclude runtime state files `.poll-state.json` and `.summarise-state.json`.
4. THE AgentHQ `.gitignore` SHALL exclude `workspace/.kiro/memory/graph.json` so that the knowledge graph is not versioned.
5. THE AgentHQ `.gitignore` SHALL contain the pattern `!.env.example` appearing after the `.env` exclusion pattern in the exact order specified, so that git tracks `.env.example` as a committed file; the order of these patterns SHALL NOT be changed, as a reordering would cause `.env.example` to be incorrectly excluded.

---

### Requirement 8: Initial Commit and GitHub Push

**User Story:** As a developer, I want an initial commit pushed to `corneldann/agenthq`
on GitHub, so that the repo is available for collaboration and backup.

#### Acceptance Criteria

1. WHEN all phases 0–5 are complete, THE AgentHQ repo SHALL contain exactly one commit; running `git show --stat HEAD` SHALL list `.env.example`, `.gitignore`, and `README.md` among the changed files.
2. THE initial commit subject line SHALL begin with `feat:` and be non-empty; messages that begin with `feat:` and are descriptive SHALL be accepted regardless of length, prioritising clarity over character count.
3. WHEN `git push -u origin main` is executed and the remote `corneldann/agenthq` contains no pre-existing commits, THE push SHALL succeed and the remote SHALL receive the initial commit.
4. IF the remote `corneldann/agenthq` already contains commits when `git push -u origin main` is executed, THE push SHALL be rejected with an error rather than overwriting remote history; the push SHALL also be rejected for any other reason that would prevent a successful push, including authentication failures, network errors, or permission issues.
5. AFTER a successful push, running `git log --oneline` in the AgentHQ repo SHALL show exactly one commit on the `main` branch.

---

### Requirement 9: Functional Verification

**User Story:** As a developer, I want to verify that AgentHQ starts and serves the
dashboard correctly after the migration, so that I know the extraction has not broken
any functionality.

#### Acceptance Criteria

1. WHEN `bun install` is run in `C:\repos\corneldann\agenthq\`, THE Package_Manager SHALL complete with exit code 0 and no error output.
2. WHEN `node_modules\.bin\tsc.exe --noEmit` is run in `C:\repos\corneldann\agenthq\`, THE TypeScript_Compiler SHALL exit with code 0 and report zero diagnostic errors.
3. WHEN `bun test test/` is run in `C:\repos\corneldann\agenthq\`, THE Test_Runner SHALL report all tests passing with no failures.
4. WHILE THE Monitor_Server is running with an Env_File whose path values point at existing directories, a GET request to `http://localhost:3333/` SHALL return HTTP 200 with `Content-Type: text/html`.
5. WHEN THE Monitor_Server starts with an Env_File that is absent or contains no path values, THE Monitor_Server SHALL emit a startup error to stderr and exit with a non-zero exit code before accepting connections.
6. WHILE THE Monitor_Server is running with a valid Env_File, a GET request to the SSE endpoint SHALL return HTTP 200 with `Content-Type: text/event-stream` and deliver at least one event within 5 seconds of connection.
7. WHILE THE Monitor_Server is running with `WORKSPACE_ROOT` set to a directory that contains a `.git` folder, a GET request to the git status endpoint SHALL return HTTP 200 with a JSON body containing at minimum the current branch name and a list of changed files.

---

### Requirement 10: Scottish Water Workspace Handover

**User Story:** As a developer, I want the Scottish Water workspace updated to point at
AgentHQ in its new location and the `agenthq/` directory removed, so that the Scottish
Water repo no longer contains monitor tooling.

#### Acceptance Criteria

1. WHEN AgentHQ is verified as working per Requirement 9, THE Scottish Water `tech-core.md` SHALL contain no occurrences of the string `agenthq/` and no occurrences of the string `sw-monitor-dashboard`, verifiable by running `grep -r "agenthq\|sw-monitor-dashboard" .kiro/steering/` and receiving zero matches.
2. WHEN AgentHQ is verified as working, THE `agenthq/` directory SHALL be removed from the Scottish Water repo working tree.
3. WHEN `agenthq/` is removed, THE Scottish Water repo SHALL contain a git commit whose subject line matches the pattern `chore(agenthq): remove agenthq/ — extracted to corneldann/agenthq` per the Conventional Commits specification.
4. WHEN AgentHQ is verified as working, THE Migration_Script SHALL copy all files from `.kiro/specs/monitor-dashboard-redesign/` to `C:\repos\corneldann\agenthq\workspace\.kiro\specs\monitor-dashboard-redesign\` and verify that the file count in the destination equals the file count in the source before deleting the source; IF the source directory is empty, THE Migration_Script SHALL halt without copying; IF the destination file count exceeds the source file count after copying, THE Migration_Script SHALL halt and report the mismatch.
5. WHEN AgentHQ is verified as working, THE Migration_Script SHALL copy all files from `.kiro/specs/monitor-server-split/` to `C:\repos\corneldann\agenthq\workspace\.kiro\specs\monitor-server-split\` and verify that the file count in the destination equals the file count in the source before deleting the source; IF the source directory is empty, THE Migration_Script SHALL halt without copying; IF the destination file count exceeds the source file count after copying, THE Migration_Script SHALL halt and report the mismatch.
6. IF the file count verification in criteria 4 or 5 fails for any reason, THE Migration_Script SHALL halt the entire handover process — not just the current copy operation — and report the mismatch without deleting the source directory; no subsequent handover steps SHALL proceed after a file count verification failure.
7. IF `agenthq/` removal from the Scottish Water repo has not been completed and verified, THEN the handover process SHALL NOT proceed, and the `agenthq/` source directory SHALL be retained; removal of the `agenthq/` directory is a prerequisite for handover completion.

---

### Requirement 11: Memory Graph Isolation

**User Story:** As a developer, I want the AgentHQ knowledge graph stored separately
from the Scottish Water knowledge graph, so that facts from one engagement do not
contaminate the other.

#### Acceptance Criteria

1. THE `workspace/.kiro/powers/agenthq-memory/mcp.json` file SHALL contain a `memory` server entry with an `env` block where `MEMORY_FILE_PATH` is set to the absolute path `C:\repos\corneldann\agenthq\workspace\.kiro\memory\graph.json`.
2. WHEN the AgentHQ memory MCP server writes a graph entry, THE entry SHALL be written to `C:\repos\corneldann\agenthq\workspace\.kiro\memory\graph.json`, and NOT to the Scottish Water memory graph file configured in `oracle-carbon-analysis/mcp.json`; Scottish Water memory operations SHALL NOT write to the AgentHQ memory graph file, enforcing bidirectional isolation; writes to the AgentHQ memory file SHALL be restricted to the AgentHQ memory MCP server only, even when the AgentHQ server itself is inactive; concurrent writes from both systems SHALL be permitted provided each system writes exclusively to its own correctly configured file.
3. THE resolved absolute path of the AgentHQ memory graph file SHALL differ from the resolved absolute path of any memory graph file configured in the Scottish Water workspace, with the comparison performed case-insensitively.
4. IF the installed version of `@modelcontextprotocol/server-memory` does not honour the `MEMORY_FILE_PATH` environment variable, THEN `workspace/.kiro/steering/tech-core.md` SHALL contain a dedicated section naming the actual default graph file path used by that package version.
