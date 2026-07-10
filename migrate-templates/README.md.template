# AgentHQ

AgentHQ is a developer agent monitor and dashboard that provides real-time visibility into Kiro agent execution, workspace scanning, git status, and prompt queuing.

## Quick Start

1. Clone: `git clone https://github.com/corneldann/agenthq.git`
2. Install: `bun install`
3. Configure: `cp .env.example .env` — fill in paths for your workspace
4. Run: `bun run src/monitor.ts`
5. Open: `http://localhost:3333`

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
