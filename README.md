# AgentHQ

AgentHQ is a developer agent monitor and dashboard that provides real-time visibility into Kiro agent execution, workspace scanning, git status, and prompt queuing.

## Quick Start

1. Clone: `git clone https://github.com/corneldann/agenthq.git`
2. Install: `bun install`
3. Configure: `cp .env.example .env` — fill in paths for your workspace
4. Run: `bun run src/monitor.ts`
5. Open: `http://localhost:3333`

## Multi-Workspace Configuration

AgentHQ can monitor multiple workspaces simultaneously using a `workspaces.json` file. This is useful when you're running Kiro agents across several projects at once and want a single dashboard view.

**Quick start:**

1. Create `workspaces.json` in the AgentHQ root:

```json
{
  "workspaces": [
    {
      "id": "my-project",
      "OUTPUT_DIR": "C:\\repos\\my-project\\output",
      "SESSIONS_DIR": "C:\\repos\\my-project\\.kiro\\sessions",
      "WORKSPACE_ROOT": "C:\\repos\\my-project"
    },
    {
      "id": "another-project",
      "OUTPUT_DIR": "C:\\repos\\another-project\\output",
      "SESSIONS_DIR": "C:\\repos\\another-project\\.kiro\\sessions",
      "WORKSPACE_ROOT": "C:\\repos\\another-project"
    }
  ]
}
```

2. Run as normal: `bun run src/monitor.ts`

When `workspaces.json` is present, it takes precedence over `.env` workspace variables. The dashboard gains a workspace filter so you can focus on one project or view all at once.

**Key fields per workspace entry:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique slug — must match `^[a-z0-9-]{1,50}$` |
| `OUTPUT_DIR` | Yes | Path to prompt output directory |
| `SESSIONS_DIR` | Yes | Path to Kiro session JSON files |
| `WORKSPACE_ROOT` | Yes | Root of the workspace to monitor |
| `CHAINS_DIR` | No | Chain files (falls back to `SESSIONS_DIR`) |
| `SPECS_DIR` | No | Kiro specs directory |
| `PROMPT_OUTPUT_DIR` | No | Prompt output path (falls back to `OUTPUT_DIR`) |
| `CRAWL_JOBS_FILE` | No | Crawl queue file path |
| `CLONE_JOBS_FILE` | No | Clone queue file path |
| `BUILD_QUEUE_FILE` | No | Build queue file path |

Up to 50 workspaces are supported. For full details, validation rules, and migration guidance see [docs/multi-workspace-setup.md](docs/multi-workspace-setup.md).

## Configuration Reference

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `OUTPUT_DIR` | Yes | Path to prompt output directory | — |
| `SESSIONS_DIR` | Yes | Path to Kiro session JSON files | — |
| `WORKSPACE_ROOT` | Yes | Root of the workspace to monitor | — |
| `CHAINS_DIR` | No | Path to chain files (falls back to SESSIONS_DIR) | `SESSIONS_DIR` |
| `WORKFLOW_DIR` | No | Kiro workflow execution directory | APPDATA-derived |
| `SPECS_DIR` | No | Path to Kiro specs directory | `""` |
| `PROMPT_OUTPUT_DIR` | No | Prompt output path (falls back to OUTPUT_DIR) | `OUTPUT_DIR` |
| `CRAWL_JOBS_FILE` | No | Crawl queue file path | `docs/reference/.crawl-queue.json` |
| `CLONE_JOBS_FILE` | No | Clone queue file path | `docs/reference/.clone-queue.json` |
| `BUILD_QUEUE_FILE` | No | Build queue file path | `docs/reference/.build-queue.json` |
| `KIRO_TOOLS_DIR` | No | Kiro tools directory | `""` |
| `PORT` | No | HTTP port | `3333` |

See `docs/examples/scottishwater.env` for a worked example.

## Build Steps

```sh
# Type-check (no execution)
node_modules\.bin\tsc.exe --noEmit

# Run tests
bun test test/

# Build dashboard SPA
bun run build:dashboard
```

> **Note on `dotenv`:** `dotenv` is currently in `devDependencies`. AgentHQ is always run via `bun run src/monitor.ts` in a development context — no packaging step is expected. A `prepack` script in `package.json` emits an error if `bun pack` or `npm pack` is attempted, preventing accidental distribution without moving `dotenv` to `dependencies`:
> ```json
> "scripts": {
>   "prepack": "echo 'ERROR: dotenv is in devDependencies. Move to dependencies before packaging.' && exit 1"
> }
> ```
