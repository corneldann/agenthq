# Multi-Workspace Setup Guide

AgentHQ can monitor multiple Kiro engagements simultaneously using a `workspaces.json` configuration file. This guide covers how to configure multiple workspaces, use the workspace filter in the dashboard, and migrate from the single-workspace `.env` setup.

---

## Table of Contents

- [Overview](#overview)
- [Configuration File Structure](#configuration-file-structure)
  - [Required Fields](#required-fields)
  - [Optional Fields](#optional-fields)
  - [Queue File Fields](#queue-file-fields)
  - [Complete Example](#complete-example)
- [Validation Rules and Error Messages](#validation-rules-and-error-messages)
  - [Fatal Errors (application exits)](#fatal-errors-application-exits)
  - [Warnings (workspace skipped, others continue)](#warnings-workspace-skipped-others-continue)
- [Workspace Filter in the Dashboard](#workspace-filter-in-the-dashboard)
  - [Using the Filter](#using-the-filter)
  - [Persistence](#persistence)
  - [What Gets Filtered](#what-gets-filtered)
- [Migration Guide: Single Workspace to Multi-Workspace](#migration-guide-single-workspace-to-multi-workspace)
  - [Step 1: Create workspaces.json](#step-1-create-workspacesjson)
  - [Step 2: Map your .env variables](#step-2-map-your-env-variables)
  - [Step 3: Verify and run](#step-3-verify-and-run)

---

## Overview

Previously, AgentHQ read workspace paths from a `.env` file and monitored a single engagement. The new multi-workspace mode replaces that with a `workspaces.json` file in the repository root that defines an array of workspace objects — one per engagement.

Each workspace entry gets a unique identifier (e.g. `scottish-water`, `project-alpha`) that appears throughout the dashboard and in API responses, letting you distinguish data from different engagements.

---

## Configuration File Structure

Create a file named `workspaces.json` in the AgentHQ repository root (same directory as `package.json`).

The file must contain a single JSON object with a `workspaces` array:

```json
{
  "workspaces": [
    {
      "id": "...",
      "OUTPUT_DIR": "...",
      "SESSIONS_DIR": "...",
      "WORKSPACE_ROOT": "..."
    }
  ]
}
```

### Required Fields

Every workspace entry must include these three fields in addition to `id`:

| Field | Description |
|-------|-------------|
| `id` | Unique workspace identifier. Must match `^[a-z0-9-]{1,50}$` — lowercase letters, digits, and hyphens only, 1–50 characters. |
| `OUTPUT_DIR` | Absolute path to the job output directory. |
| `SESSIONS_DIR` | Absolute path to the Kiro session `.jsonl` files directory. |
| `WORKSPACE_ROOT` | Absolute path to the engagement workspace root (used for git operations). |

### Optional Fields

| Field | Description | Default |
|-------|-------------|---------|
| `CHAINS_DIR` | Absolute path to chain execution logs directory. | `SESSIONS_DIR` |
| `SPECS_DIR` | Absolute path to the Kiro specs directory. | _(not set)_ |
| `PROMPT_OUTPUT_DIR` | Absolute path to prompt outputs directory. | `OUTPUT_DIR` |

### Queue File Fields

These are optional relative paths interpreted relative to `WORKSPACE_ROOT`:

| Field | Description | Example default |
|-------|-------------|-----------------|
| `CRAWL_JOBS_FILE` | Relative path to the crawl queue JSON file. | `docs/reference/.crawl-queue.json` |
| `CLONE_JOBS_FILE` | Relative path to the clone queue JSON file. | `docs/reference/.clone-queue.json` |
| `BUILD_QUEUE_FILE` | Relative path to the build queue JSON file. | `docs/reference/.build-queue.json` |

### Complete Example

```json
{
  "workspaces": [
    {
      "id": "scottish-water",
      "OUTPUT_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\docs\\analysis\\prompts\\output",
      "SESSIONS_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\.kiro\\sessions",
      "WORKSPACE_ROOT": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater",
      "CHAINS_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\.kiro\\sessions",
      "SPECS_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\.kiro\\specs",
      "PROMPT_OUTPUT_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\docs\\analysis\\prompts\\output",
      "CRAWL_JOBS_FILE": "docs/reference/.crawl-queue.json",
      "CLONE_JOBS_FILE": "docs/reference/.clone-queue.json",
      "BUILD_QUEUE_FILE": "docs/reference/.build-queue.json"
    },
    {
      "id": "project-alpha",
      "OUTPUT_DIR": "C:\\Users\\Admin\\Repos\\ProjectAlpha\\output",
      "SESSIONS_DIR": "C:\\Users\\Admin\\Repos\\ProjectAlpha\\.kiro\\sessions",
      "WORKSPACE_ROOT": "C:\\Users\\Admin\\Repos\\ProjectAlpha"
    }
  ]
}
```

The second workspace uses only required fields. `CHAINS_DIR` defaults to `SESSIONS_DIR` and `PROMPT_OUTPUT_DIR` defaults to `OUTPUT_DIR` automatically.

---

## Validation Rules and Error Messages

AgentHQ validates `workspaces.json` at startup. Errors either cause the application to exit immediately or skip the affected workspace and continue.

### Fatal Errors (application exits)

These conditions prevent AgentHQ from starting:

| Condition | Log message |
|-----------|-------------|
| `workspaces.json` not found | `ERROR: Configuration file not found: <path>` |
| `workspaces.json` contains invalid JSON | `ERROR: Failed to parse configuration file: <path>\nJSON parse error: <details>` |
| Duplicate `id` values | `ERROR: Duplicate workspace IDs detected: <id1>, <id2>` |
| More than 50 workspaces defined | `ERROR: Configuration exceeds maximum workspace limit: <count> workspaces (max: 50)` |
| `id` value does not match `^[a-z0-9-]{1,50}$` | `ERROR: Workspace "<id>": Workspace ID must match pattern ^[a-z0-9-]{1,50}$ (at workspaces.<index>.id)` |
| Required field (`OUTPUT_DIR`, `SESSIONS_DIR`, or `WORKSPACE_ROOT`) missing from schema | `ERROR: Workspace "<id>": <field> is required (at workspaces.<index>.<field>)` |

**Workspace ID rules in detail:**
- Only lowercase ASCII letters (`a-z`), digits (`0-9`), and hyphens (`-`)
- Minimum 1 character, maximum 50 characters
- No uppercase letters, spaces, underscores, or special characters

**Duplicate ID check:** Comparison is case-sensitive. `scottish-water` and `Scottish-Water` would be treated as different IDs — but using both is strongly discouraged as it creates confusion.

### Warnings (workspace skipped, others continue)

These conditions log a warning, skip the affected workspace, and allow AgentHQ to continue with the remaining valid workspaces:

| Condition | Log message |
|-----------|-------------|
| `OUTPUT_DIR` path does not exist on disk | `WARNING: Workspace "<id>": required path OUTPUT_DIR does not exist: <path>` |
| `SESSIONS_DIR` path does not exist on disk | `WARNING: Workspace "<id>": required path SESSIONS_DIR does not exist: <path>` |
| `WORKSPACE_ROOT` path does not exist on disk | `WARNING: Workspace "<id>": required path WORKSPACE_ROOT does not exist: <path>` |

After a path warning, AgentHQ also logs:

```
WARNING: Skipping workspace "<id>"
```

If all workspaces are skipped due to missing paths, AgentHQ logs:

```
WARNING: All <N> workspace(s) skipped due to path validation failures
```

and continues running with an empty workspace list (the dashboard will show no data).

**Note:** Optional fields (`CHAINS_DIR`, `SPECS_DIR`, `PROMPT_OUTPUT_DIR`) are not checked for filesystem existence — only the three required paths are validated.

---

## Workspace Filter in the Dashboard

### Using the Filter

The workspace selector is a dropdown in the navigation bar, visible on every page. It lists all successfully loaded workspaces alongside an "All Workspaces" option.

Workspace IDs are displayed in Title Case. For example:
- `scottish-water` → **Scottish Water**
- `project-alpha` → **Project Alpha**

### Persistence

Your selection is automatically saved to browser `localStorage` under the key `selectedWorkspaceId`. When you reload the page, the last-selected workspace is restored.

If the stored ID no longer matches any configured workspace (e.g. the workspace was removed from `workspaces.json`), the filter resets to "All Workspaces".

If the browser's `localStorage` is unavailable or full, AgentHQ logs a console warning and continues without persisting the selection — the filter still works for the current session.

### What Gets Filtered

Selecting a workspace filters all data in the dashboard simultaneously:

| View | Filtered by |
|------|-------------|
| Chains | `workspaceId` field on each chain |
| Jobs | `workspaceId` field on each job |
| Sessions | `workspaceId` field on each session |
| Git status | `workspaceId` field on each git status block |

Selecting "All Workspaces" shows data from every configured workspace with no filtering applied.

Real-time SSE updates also respect the current filter — updates from other workspaces are not applied to the display when a specific workspace is selected.

---

## Migration Guide: Single Workspace to Multi-Workspace

If you previously configured AgentHQ using a `.env` file, follow these steps to migrate to `workspaces.json`.

### Step 1: Create workspaces.json

In the AgentHQ repository root, create a new file named `workspaces.json`.

### Step 2: Map your .env variables

Open your existing `.env` file and map each path variable to the corresponding field in `workspaces.json`. The mapping is direct:

| `.env` variable | `workspaces.json` field |
|-----------------|------------------------|
| `OUTPUT_DIR` | `OUTPUT_DIR` |
| `SESSIONS_DIR` | `SESSIONS_DIR` |
| `WORKSPACE_ROOT` | `WORKSPACE_ROOT` |
| `CHAINS_DIR` | `CHAINS_DIR` (optional) |
| `SPECS_DIR` | `SPECS_DIR` (optional) |
| `PROMPT_OUTPUT_DIR` | `PROMPT_OUTPUT_DIR` (optional) |
| `CRAWL_JOBS_FILE` | `CRAWL_JOBS_FILE` (optional) |
| `CLONE_JOBS_FILE` | `CLONE_JOBS_FILE` (optional) |
| `BUILD_QUEUE_FILE` | `BUILD_QUEUE_FILE` (optional) |

**Not migrated:** `PORT`, `WORKFLOW_DIR`, and `KIRO_TOOLS_DIR` remain in `.env` — they are server-level settings, not per-workspace paths.

**Example:** Given this `.env`:

```dotenv
OUTPUT_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\ScottishWater\docs\analysis\prompts\output
SESSIONS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\ScottishWater\.kiro\sessions
CHAINS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\ScottishWater\.kiro\sessions
WORKSPACE_ROOT=C:\Users\Admin\OneDrive - PBT Group\Repos\ScottishWater
SPECS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\ScottishWater\.kiro\specs
PROMPT_OUTPUT_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\ScottishWater\docs\analysis\prompts\output
CRAWL_JOBS_FILE=docs/reference/.crawl-queue.json
CLONE_JOBS_FILE=docs/reference/.clone-queue.json
BUILD_QUEUE_FILE=docs/reference/.build-queue.json
```

Create this `workspaces.json`:

```json
{
  "workspaces": [
    {
      "id": "scottish-water",
      "OUTPUT_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\docs\\analysis\\prompts\\output",
      "SESSIONS_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\.kiro\\sessions",
      "WORKSPACE_ROOT": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater",
      "CHAINS_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\.kiro\\sessions",
      "SPECS_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\.kiro\\specs",
      "PROMPT_OUTPUT_DIR": "C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\ScottishWater\\docs\\analysis\\prompts\\output",
      "CRAWL_JOBS_FILE": "docs/reference/.crawl-queue.json",
      "CLONE_JOBS_FILE": "docs/reference/.clone-queue.json",
      "BUILD_QUEUE_FILE": "docs/reference/.build-queue.json"
    }
  ]
}
```

Choose an `id` that identifies your engagement — lowercase, hyphens only, no spaces.

### Step 3: Verify and run

Start AgentHQ as normal:

```sh
bun run src/monitor.ts
```

Check the console output. If any paths are wrong you will see a `WARNING: Skipping workspace` message with the specific path that was not found. Fix the path in `workspaces.json` and restart.

Once running, open the dashboard at `http://localhost:3333`. The workspace selector in the navigation bar will show your workspace name. Since you only have one workspace, the selector makes no functional difference — but you can add further workspaces to `workspaces.json` at any time without restarting, following the same structure.
