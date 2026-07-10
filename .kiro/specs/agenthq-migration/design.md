# Design Document — AgentHQ Migration

## Overview

AgentHQ is extracted from the `agenthq/` subdirectory of the Scottish Water engagement repo
into a standalone, engagement-agnostic repository at `C:\repos\corneldann\agenthq\` and
published as `corneldann/agenthq` on GitHub.

The migration has three concerns:

1. **Extraction** — copy source files to the new repo, strip engagement-specific artefacts,
   and initialise git with the correct remote.
2. **De-hardcoding** — replace every hardcoded Scottish Water path in `src/constants.ts` with
   environment-variable fallback expressions, document them in `.env.example`, and add startup
   validation in `src/monitor.ts` so missing configuration is caught immediately.
3. **Workspace portability** — commit Kiro configuration (steering, skills, powers, memory)
   under `workspace/` so the tool works out-of-the-box in any Kiro-capable workspace.

The migration is carried out by a PowerShell script (`migrate.ps1`) that is itself version-
controlled. The Scottish Water workspace is then updated to remove `agenthq/` and the two
existing feature specs are relocated to the AgentHQ `workspace/.kiro/specs/` tree.

### Design Improvements (Areas for Consideration Implemented)

This design incorporates enhancements from the initial design review:

**1. PowerShell Script Structure**
- Helper functions extract reusable logic (`Copy-WithValidation`, `Copy-Spec`, `Assert-NoMatch`, `Invoke-WithTimeout`, `Read-Template`)
- Progress indicators for long-running operations (Phase 2 robocopy, Phase 9 bun install)
- Template-based content generation eliminates PowerShell escaping issues

**2. Phase 0.5 Simplification**
- Simplified to best-effort extraction with clear advisory status
- Fallback messages documented for all failure scenarios
- Runtime verification (Phase 9) is the authoritative check

**3. Memory Isolation Enhanced Error Handling**
- Timeout handling (2s wait for file creation)
- Cleanup in `finally` blocks ensures temp files always removed
- Process cleanup (server stopped on all paths)
- Clear failure messages with recovery instructions

**4. Scottish Water Handover Pre-Verification**
- Git status check before modification (detects uncommitted changes)
- Grep pattern pre-verification before replacement (warns if patterns don't match)
- User confirmation prompt if pre-verification raises warnings
- Verified patterns tested against actual files before execution

**5. README.md Template-Based Generation**
- Content stored in `migrate-templates/README.md.template`
- Eliminates here-string escaping complexity for nested code fences
- Easy content updates via direct markdown editing

**6. dotenv Dependency Resolution**
- Moved from `devDependencies` to `dependencies` in package.json
- `prepack` script guards against accidental distribution
- Supports potential future packaging scenarios

**7. Phase 9 HTTP Smoke Tests**
- Port conflict detection (uses 13333 if 3333 in use)
- Timeout handling for HTTP requests (5s limit)
- Process cleanup in `finally` blocks
- Structured error messages

### Design-to-Requirements Traceability

| Requirement | Design Sections |
|-------------|-----------------|
| Req 1 (Repository Initialisation) | Migration Phases 0–2, Migration_Script component, Property 1, Error Handling |
| Req 2 (Name Replacement) | Migration Phase 3, Name Replacement Strategy, Property 2, Property 5 |
| Req 3 (Env-Var Configuration) | Constants_Module component, Data Models (Env Var Resolution Table), Property 3 |
| Req 4 (Startup Validation) | Startup Path Validation component, validation.ts module, Property 4 |
| Req 5 (Env_Example Documentation) | .env / .env.example Design, README Structure |
| Req 6 (Kiro Workspace Config) | workspace/ Directory Structure, Migration Phase 5 |
| Req 7 (Project Hygiene) | .gitignore Design |
| Req 8 (Initial Commit) | Migration Phase 8, Error Handling (Git Push) |
| Req 9 (Functional Verification) | Migration Phase 9, Testing Strategy (Integration Tests) |
| Req 10 (SW Handover) | Migration Phase 10, Scottish Water Handover component, Error Handling |
| Req 11 (Memory Isolation) | Memory Graph Isolation Design, Migration Phase 0.5, Phase 9 runtime check |

### Retry and Rollback Strategy

**Migration Script Retry Behavior:**

The migration script enforces a **strict no-retry policy** to prevent data loss. If `migrate.ps1` is run multiple times:

1. **First run**: Phase 0 pre-flight checks pass → migration proceeds
2. **Second run** (after partial failure): Phase 0 detects destination exists → script halts with error before any operations execute
3. **Developer action required**: Manual cleanup of `C:\repos\corneldann\agenthq\` before retry

This design is intentional. Robocopy `/MIR` in Phase 2 would **delete any manually applied fixes** in the destination if Phase 0 didn't halt. The Phase 0 guard is the only protection against this.

**Rollback Procedure (if Phase 9 or Phase 10 fails):**

If the migration fails after Phase 8 (git repository created):

1. **Rollback destination repo**: `Remove-Item C:\repos\corneldann\agenthq -Recurse -Force`
2. **Rollback SW workspace** (if Phase 10 partial): 
   - `git restore .kiro/steering/tech-core.md` (if modified)
   - `git clean -fd agenthq/` (if partially removed)
3. **Review logs**: Check Phase N failure message in script output
4. **Fix root cause**: Address network, permissions, or path issues
5. **Re-run**: `.\migrate.ps1` (Phase 0 will pass after rollback)

**Pre-Migration Backup (recommended but not enforced):**

Before running `migrate.ps1`:
```powershell
# Backup agenthq/ to temporary location
robocopy agenthq\ C:\temp\agenthq-backup\ /MIR
# Note: this is optional — source repo is not modified until Phase 10
```

**Dry-Run Mode (not implemented):**

The script does NOT support a dry-run mode. The Phase 0 pre-flight checks serve as validation. To preview what would be copied without executing:
```powershell
# Preview robocopy operation (list only, no copy)
robocopy agenthq\ C:\repos\corneldann\agenthq\ /MIR /XD node_modules .venv dist /XF .poll-state.json .summarise-state.json /L
```

### Edge Cases and Operational Constraints

**Pre-Migration Checklist (Task 0):**

Before running `migrate.ps1`, verify:

1. ✅ **Bun installed**: `bun --version` returns ≥1.0.0
2. ✅ **Git available**: `git --version` succeeds
3. ✅ **SW workspace clean**: `git status` shows no uncommitted changes to `.kiro/steering/tech-core.md`
4. ✅ **Destination clear**: `C:\repos\corneldann\agenthq\` does not exist
5. ✅ **Source exists**: `agenthq\` directory present in current working directory
6. ✅ **Network access**: Can reach npm registry and GitHub (for Phase 9 `bun install` and Phase 8 push)
7. ✅ **Disk space**: At least 500MB free on C: drive
8. ⚠️ **Optional backup**: `robocopy agenthq\ C:\temp\agenthq-backup\ /MIR` (source not modified until Phase 10)

Phase 0 pre-flight checks will enforce items 1–5. Items 6–8 are advisory.

**Edge Case 1: Remote repository already exists with different content**

If `git push -u origin main` is executed and `corneldann/agenthq` already contains commits:
- **Behavior**: Git rejects the push with `! [rejected] main -> main (fetch first)`
- **Script action**: Phase 8 calls `Fail` → migration halts → destination repo retained locally but not pushed
- **Recovery**: Developer must either delete remote repo or force-push (not automated to prevent data loss)

**Edge Case 2: Uncommitted changes in Scottish Water workspace during Phase 10**

Phase 10 modifies `.kiro/steering/tech-core.md` in the SW workspace. If this file has uncommitted changes when `migrate.ps1` runs:
- **Phase 10 behavior**: Overwrites the file in place (PowerShell `Set-Content`)
- **Uncommitted changes**: **Lost** unless developer committed or stashed before migration
- **Pre-migration checklist** (Task 0): Verify `git status` is clean in SW workspace before running script

**Edge Case 3: Windows path length limits (MAX_PATH = 260 characters)**

Robocopy handles long paths natively (uses `\\?\` prefix internally), but git and TypeScript compiler may fail on paths >260 chars. Mitigation:
- **Pre-flight check addition**: Add path-length validation to Phase 0 before copy
- **Destination path**: `C:\repos\corneldann\agenthq\` is 30 chars (safe)
- **Known long paths**: `workspace/.kiro/skills/<skill-name>/SKILL.md` — longest expected ~120 chars total (safe)
- **If MAX_PATH exceeded**: Windows 10+ supports long paths via registry (`LongPathsEnabled=1`) or use `\\?\C:\...` syntax

**Edge Case 4: Bun runtime not installed or wrong version**

Phase 9 assumes `bun` is in PATH. If not installed:
- **Symptom**: `bun install` fails with "command not found"
- **Phase 9 behavior**: Calls `Fail` → migration halts before verification
- **Pre-migration checklist**: Verify `bun --version` returns ≥1.0.0 before running script

---

## Architecture

### Repository Layout (post-migration)

```
C:\repos\corneldann\agenthq\
├── src/
│   ├── constants.ts            ← Constants_Module (env-var driven, exports resolveConstants factory)
│   ├── monitor.ts              ← Monitor_Server entry point (startup validation added)
│   ├── validation.ts           ← Pure validation helpers (findUnconfiguredVars, validateEnvPaths)
│   ├── cli.ts
│   ├── router.ts
│   ├── types.ts
│   ├── dashboard/              ← Dashboard SPA (unchanged except <title>)
│   │   ├── index.html          ← <title>AgentHQ</title>
│   │   └── ...
│   ├── routes/
│   ├── scan/
│   └── workers/
├── test/
├── dist/                       ← .gitignore'd; built by Bun
├── workspace/
│   ├── agenthq.code-workspace
│   └── .kiro/
│       ├── steering/
│       │   ├── tech-core.md
│       │   ├── agent-batching.md
│       │   └── task-concurrency.md
│       ├── skills/
│       │   ├── agenthq-dashboard/SKILL.md
│       │   └── <20 other skills>/
│       ├── powers/
│       │   └── agenthq-memory/mcp.json
│       ├── specs/              ← migrated specs from SW repo
│       │   ├── monitor-dashboard-redesign/
│       │   └── monitor-server-split/
│       └── memory/
│           └── .gitkeep
├── docs/
│   └── examples/
│       └── scottishwater.env   ← reference .env for Scottish Water engagement
├── .env                        ← .gitignore'd; deployment-specific paths
├── .env.example                ← committed; documents all variables
├── .gitignore
├── README.md
├── package.json                ← name: "agenthq"
└── tsconfig.json
```

### Migration Phases

```
Phase 0: Pre-flight checks (paths exist, destination does not exist, git available, bun installed, SW workspace clean)
Phase 0.5: Memory server pre-flight (simplified — extract default path if available, write placeholder note otherwise)
Phase 1: Directory creation (agenthq/, workspace/)
Phase 2: File copy (robocopy with exclusions + precise file-count validation + path-length check + progress indicator)
Phase 3: Name replacement (package.json, index.html, monitor.ts log)
Phase 4: Constants_Module rewrite (src/constants.ts) + validation.ts creation
Phase 5: Workspace/ population (steering with generated tech-core.md from template file, skills, powers, memory scaffold)
Phase 6: .env files (.env.example, .gitignore, docs/examples/scottishwater.env)
Phase 7: README.md creation (from template file)
Phase 8: Git init + remote setup
Phase 9: Functional verification (tsc, bun install with timeout, bun test, smoke HTTP tests with port conflict handling, memory isolation runtime check with cleanup)
Phase 10: Scottish Water handover (SW workspace backup check, tech-core.md rewrite with verified grep patterns, spec migration, agenthq/ removal, commit)
```

**Phase structure improvements:**

- **Helper functions**: Phases 2, 5, 6, 7, 9, 10 are broken into reusable helper functions (see Helper Functions section below)
- **Progress indicators**: Phase 2 (robocopy), Phase 5 (workspace population), Phase 9 (bun install) emit progress updates
- **Template files**: Phase 5 and Phase 7 read from `migrate-templates/` directory rather than inline here-strings
- **Enhanced error handling**: Phase 9 includes timeout and port conflict handling; Phase 10 includes pre-modification verification

**Phase 0 Pre-flight Checks (expanded):**

```powershell
$currentPhase = "0"

# Check 1: Source path exists
if (-not (Test-Path "agenthq\")) {
    Fail "Source directory agenthq\ does not exist"
}

# Check 2: Destination does not exist (critical guard for /MIR safety)
if (Test-Path $DEST) {
    Fail "Destination already exists: $DEST. Remove it before re-running migrate.ps1."
}

# Check 3: Git is available
$gitVersion = git --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "Git is not installed or not in PATH"
}

# Check 4: Bun is available and version ≥1.0.0
$bunVersion = bun --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "Bun is not installed or not in PATH. Install from https://bun.sh"
}
$bunMajor = [int]($bunVersion -split '\.')[0]
if ($bunMajor -lt 1) {
    Fail "Bun version $bunVersion is too old (require ≥1.0.0)"
}

# Check 5: Scottish Water workspace has no uncommitted changes to tech-core.md
$swStatus = git status --porcelain .kiro/steering/tech-core.md 2>&1
if ($swStatus.Length -gt 0) {
    Fail "Scottish Water workspace has uncommitted changes to .kiro/steering/tech-core.md. Commit or stash before migration."
}

# Check 6: Verify no long paths that would exceed MAX_PATH
$longPaths = Get-ChildItem "agenthq\" -Recurse -File | Where-Object {
    $_.FullName.Length -gt 240  # 240 + 30 chars for destination prefix = 270 (safe buffer)
}
if ($longPaths.Count -gt 0) {
    Write-Warning "Found $($longPaths.Count) file(s) with paths approaching MAX_PATH limit:"
    $longPaths | ForEach-Object { Write-Warning "  $($_.FullName) ($($_.FullName.Length) chars)" }
    Fail "Enable LongPathsEnabled in Windows registry or shorten paths before migration"
}

Write-Host "[Phase 0] All pre-flight checks passed"
```

Each phase is wrapped in a PowerShell `try/catch` that halts the script on failure and exits
with a non-zero exit code, satisfying Requirement 1.8.

---

### Helper Functions (PowerShell)

To reduce complexity and improve testability, the migration script is structured with reusable helper functions:

```powershell
# Progress reporting helper
function Write-Progress-Step([string]$phase, [string]$message) {
    Write-Host "[$phase] $message" -ForegroundColor Cyan
}

# File copy helper with progress and validation
function Copy-WithValidation {
    param(
        [string]$Source,
        [string]$Dest,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFiles = @()
    )
    
    Write-Progress-Step "Copy" "Starting robocopy: $Source -> $Dest"
    
    $robocopyArgs = @($Source, $Dest, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS')
    if ($ExcludeDirs.Count -gt 0) { $robocopyArgs += '/XD'; $robocopyArgs += $ExcludeDirs }
    if ($ExcludeFiles.Count -gt 0) { $robocopyArgs += '/XF'; $robocopyArgs += $ExcludeFiles }
    
    robocopy @robocopyArgs | Out-Null
    
    if ($LASTEXITCODE -ge 8) {
        Fail "robocopy failed with exit code $LASTEXITCODE"
    }
    
    Write-Progress-Step "Copy" "Validating file count and structure..."
    
    # File count validation (existing logic)
    $srcFiles = Get-ChildItem $Source -Recurse -File | Where-Object {
        $ExcludeFiles -notcontains $_.Name -and
        -not ($_.FullName -split '\\' | Where-Object { $ExcludeDirs -contains $_ })
    }
    $srcExpected = $srcFiles.Count
    $destCount = (Get-ChildItem $Dest -Recurse -File | Measure-Object).Count
    
    if ($destCount -ne $srcExpected) {
        Fail "File count mismatch: expected $srcExpected, got $destCount"
    }
    
    # Structural validation (existing logic)
    foreach ($srcFile in $srcFiles) {
        $relativePath = $srcFile.FullName.Substring($Source.Length).TrimStart('\')
        $destFile = Join-Path $Dest $relativePath
        if (-not (Test-Path $destFile)) {
            Fail "Structural mismatch: missing file at destination: $relativePath"
        }
    }
    
    Write-Progress-Step "Copy" "Validation complete: $destCount files copied"
}

# Spec migration helper with file-count guard
function Copy-Spec {
    param([string]$SrcDir, [string]$DestDir)
    
    if (Test-Path $DestDir) {
        Fail "Spec destination already exists: $DestDir. Remove before re-running."
    }
    
    $srcFiles = @(Get-ChildItem $SrcDir -Recurse -File)
    if ($srcFiles.Count -eq 0) {
        Fail "Source spec directory is empty: $SrcDir"
    }
    
    Write-Progress-Step "Phase 10" "Copying spec: $SrcDir -> $DestDir ($($srcFiles.Count) files)"
    
    robocopy $SrcDir $DestDir /E /NFL /NDL /NJH /NJS | Out-Null
    
    $destFiles = @(Get-ChildItem $DestDir -Recurse -File)
    if ($destFiles.Count -ne $srcFiles.Count) {
        Fail "File count mismatch after spec copy: src=$($srcFiles.Count) dest=$($destFiles.Count)"
    }
    
    Write-Progress-Step "Phase 10" "Spec copy verified, removing source: $SrcDir"
    Remove-Item $SrcDir -Recurse -Force
}

# Template file reader helper
function Read-Template {
    param([string]$TemplateName)
    
    $templatePath = Join-Path $PSScriptRoot "migrate-templates\$TemplateName"
    if (-not (Test-Path $templatePath)) {
        Fail "Template file not found: $templatePath"
    }
    
    return Get-Content $templatePath -Raw
}

# Grep verification helper
function Assert-NoMatch {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Description
    )
    
    $hits = Select-String -Path $Path -Pattern $Pattern -Recurse 2>$null
    if ($hits) {
        Write-Warning "$Description verification failed. Found matches:"
        $hits | ForEach-Object { Write-Warning "  $($_.Path):$($_.LineNumber): $($_.Line)" }
        Fail "$Description: found prohibited pattern '$Pattern' in $Path"
    }
    Write-Progress-Step "Verification" "$Description: no matches for '$Pattern' in $Path"
}

# Timeout wrapper for long-running commands
function Invoke-WithTimeout {
    param(
        [scriptblock]$ScriptBlock,
        [int]$TimeoutSeconds = 300,
        [string]$Description = "Command"
    )
    
    Write-Progress-Step "Timeout" "Running: $Description (timeout: ${TimeoutSeconds}s)"
    
    $job = Start-Job -ScriptBlock $ScriptBlock
    $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
    
    if (-not $completed) {
        Stop-Job -Job $job
        Remove-Job -Job $job
        Fail "$Description exceeded timeout of ${TimeoutSeconds}s"
    }
    
    $result = Receive-Job -Job $job
    Remove-Job -Job $job
    
    if ($LASTEXITCODE -ne 0) {
        Fail "$Description failed with exit code $LASTEXITCODE"
    }
    
    return $result
}
```

These helpers are used throughout phases 2, 5, 6, 7, 9, and 10 to reduce duplication and improve maintainability.

---

### Migration Template Files

To separate content from script logic and eliminate PowerShell escaping issues, certain large text blocks are stored as separate template files in the `migrate-templates/` directory.

**Directory structure:**
```
migrate-templates/
├── tech-core.md.template       — AgentHQ tech-core.md content with {{PLACEHOLDER}} substitution
└── README.md.template           — AgentHQ README.md complete content
```

**Template placeholders:**

`tech-core.md.template` uses the following substitution markers:
- `{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}` — replaced with the Phase 0.5 advisory extraction result

**Benefits of template-based approach:**
1. **No PowerShell escaping issues** — markdown code fences, backticks, and quotes are literal
2. **Easy content updates** — edit markdown directly rather than modifying PowerShell string literals
3. **Syntax highlighting** — editors recognize .md.template as markdown
4. **Reduced script complexity** — Phase 5 and Phase 7 logic is simplified to read-and-substitute
5. **Testable content** — templates can be validated independently of script execution

**Implementation:**

```powershell
# Helper function (defined in Helper Functions section)
function Read-Template {
    param([string]$TemplateName)
    
    $templatePath = Join-Path $PSScriptRoot "migrate-templates\$TemplateName"
    if (-not (Test-Path $templatePath)) {
        Fail "Template file not found: $templatePath"
    }
    
    return Get-Content $templatePath -Raw
}

# Usage in Phase 5
$techCoreTemplate = Read-Template "tech-core.md.template"
$techCoreContent = $techCoreTemplate -replace '{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}', $MEMORY_SERVER_DEFAULT_PATH_NOTE
Set-Content -Path "$DEST\workspace\.kiro\steering\tech-core.md" -Value $techCoreContent

# Usage in Phase 7
$readmeContent = Read-Template "README.md.template"
Set-Content -Path "$DEST\README.md" -Value $readmeContent
```

The `migrate-templates/` directory is version-controlled alongside `migrate.ps1` in the Scottish Water repo. After migration, it is not copied to the AgentHQ repo (not needed at runtime).

---

## Components and Interfaces

### Migration_Script (`migrate.ps1`)

The script lives at the root of the Scottish Water repo (or a `scripts/` sub-directory) and
is invoked manually by the developer after review.

**Key design decisions:**

- Uses `robocopy` for the file copy: supports exclusion lists natively, produces a structured
  exit-code convention (codes 0–7 are success variants; ≥8 indicate errors), and handles
  large directory trees without path-length issues on Windows.
- The main copy phase (Phase 2) uses `/MIR` which mirrors the source — it deletes any
  destination-only files. This is safe **only** because Phase 0 (pre-flight) explicitly
  verifies the destination directory does NOT already exist:
  ```powershell
  # CRITICAL GUARD — do NOT remove or bypass this check.
  # Phase 2 uses robocopy /MIR which DELETES any file in $DEST that is not in $SOURCE.
  # If $DEST already exists (e.g. from a partial first run), /MIR will destroy any
  # manually applied edits in the destination before this check can prevent it.
  # This Phase 0 check is the only thing that makes /MIR safe to use here.
  if (Test-Path $DEST) {
      Fail "Destination already exists: $DEST. Remove it before re-running migrate.ps1."
  }
  ```
  If the script is run a second time after a partial first run, Phase 0 halts before
  `/MIR` can delete any manually applied edits in the destination.
- The `Copy-Spec` helper in Phase 10 uses `/E` instead of `/MIR`, since the destination spec
  directories should only receive files, never have pre-existing content deleted.
- Exclusion list passed as `/XD` (directories) and `/XF` (files) flags:
  - `/XD node_modules .venv dist`
  - `/XF .poll-state.json .summarise-state.json`
- After copy, the script runs a file-count validation:
  ```powershell
  # Count excluded items that would have been present in source
  $excludedDirs  = @('node_modules', '.venv', 'dist')
  $excludedFiles = @('.poll-state.json', '.summarise-state.json')

  $srcFiles = Get-ChildItem $SOURCE -Recurse -File | Where-Object {
      $excludedFiles -notcontains $_.Name -and
      -not ($_.FullName -split '\\' | Where-Object { $excludedDirs -contains $_ })
  }
  $srcExpected = $srcFiles.Count
  $destCount   = (Get-ChildItem $DEST -Recurse -File | Measure-Object).Count

  if ($destCount -ne $srcExpected) {
      Fail "File count mismatch after copy: expected $srcExpected, got $destCount"
  }

  # Path-level structural verification — count alone is insufficient
  # (a renamed + missing file pair would pass a count-only check)
  foreach ($srcFile in $srcFiles) {
      $relativePath = $srcFile.FullName.Substring($SOURCE.Length).TrimStart('\')
      $destFile = Join-Path $DEST $relativePath
      if (-not (Test-Path $destFile)) {
          Fail "Structural mismatch: expected file missing at destination: $relativePath"
      }
  }
  ```
  This enforces two complementary invariants: (1) a file count comparison between source and destination to catch bulk copy failures, and (2) a path-level structural check that verifies each non-excluded source file exists at its exact corresponding path in the destination. A count-only check would pass if a file were renamed during copy and another were missing — the path check catches this. The exclusion count is computed by walking the source tree and applying the same exclusion rules as robocopy — ensuring the comparison is exact.
- Failure handler pattern used throughout:
  ```powershell
  function Fail([string]$msg) {
      Write-Error "MIGRATION FAILED (Phase $currentPhase): $msg"
      exit 1
  }
  ```

**Phase 0.5 — Memory server pre-flight (simplified):**

The migration script attempts to extract the default graph path from the installed memory server package. This is **advisory only** and serves to populate a reference note in `workspace/.kiro/steering/tech-core.md`.

**Design simplification:** Rather than attempting complex grep logic on potentially minified bundles, Phase 0.5 now uses a simpler approach:

```powershell
$currentPhase = "0.5"
$memServerJs = "$env:APPDATA\npm\node_modules\@modelcontextprotocol\server-memory\dist\index.js"

if (-not (Test-Path $memServerJs)) {
    Write-Warning "[Phase 0.5] Memory server package not found — runtime verification will be required."
    $MEMORY_SERVER_DEFAULT_PATH_NOTE = "Package not found during Phase 0.5. Runtime verification in Phase 9 will confirm MEMORY_FILE_PATH is honoured."
} else {
    # Attempt simple pattern match (best-effort)
    $defaultPathLine = Select-String -Path $memServerJs -Pattern 'MEMORY_FILE_PATH|graph\.json' -Context 0,1 | Select-Object -First 1
    if ($defaultPathLine) {
        $MEMORY_SERVER_DEFAULT_PATH_NOTE = "Found during Phase 0.5 (advisory): $($defaultPathLine.Line.Trim())"
    } else {
        $MEMORY_SERVER_DEFAULT_PATH_NOTE = "Could not extract default path from bundled source. Runtime verification in Phase 9 will confirm isolation."
    }
    Write-Host "[Phase 0.5] Memory server default path note recorded (advisory only)"
}
```

**Rationale:** The advisory nature of Phase 0.5 is now explicit. The note written to tech-core.md is a best-effort reference. Runtime verification in Phase 9 is the authoritative check for memory isolation.

**Phase 2 — File copy with progress:**

```powershell
$currentPhase = "2"

$excludedDirs = @('node_modules', '.venv', 'dist')
$excludedFiles = @('.poll-state.json', '.summarise-state.json')

Copy-WithValidation -Source "agenthq\" -Dest $DEST `
    -ExcludeDirs $excludedDirs -ExcludeFiles $excludedFiles

Write-Host "[Phase 2] File copy complete and verified"
```

The `Copy-WithValidation` helper emits progress updates during the robocopy operation and performs both file-count and structural validation before returning.

---

### `src/validation.ts` (new module)

All startup validation and path-check logic is extracted into a dedicated, side-effect-free module so that tests can import it without triggering the Bun HTTP server.

```typescript
// src/validation.ts
import * as fs from "fs";

export interface EnvConfig {
  OUTPUT_DIR: string;
  SESSIONS_DIR: string;
  WORKSPACE_ROOT: string;
  [key: string]: string;
}

/**
 * Returns the list of required variable names that are absent or empty.
 * Pure function — no process.exit, no console output, no imports from monitor.ts.
 */
export function findUnconfiguredVars(env: EnvConfig): string[] {
  const REQUIRED = ["OUTPUT_DIR", "SESSIONS_DIR", "WORKSPACE_ROOT"] as const;
  return REQUIRED.filter(name => !env[name]);
}

/**
 * Returns the list of variable names whose configured paths do not exist on disk.
 * Pure function — accepts an injectable pathExists so tests can pass a fake without real I/O.
 */
export function validateEnvPaths(
  env: EnvConfig,
  pathExists: (p: string) => boolean = (p) => fs.existsSync(p)
): string[] {
  const CHECKED = ["OUTPUT_DIR", "SESSIONS_DIR", "WORKSPACE_ROOT"] as const;
  return CHECKED.filter(name => {
    const v = env[name];
    return v.length === 0 || !pathExists(v);
  });
}
```

`monitor.ts` imports `findUnconfiguredVars` and `validateEnvPaths` from this module. All worker module imports appear **after** the validation block — no `import`-level side effects can fire before `process.exit(1)` is reached.

---

### Constants_Module (`src/constants.ts`)

**Current state** (to be replaced):
- `WORKSPACE_ROOT` — derived from `import.meta.dir` (hardcoded to the agenthq directory structure)
- `OUTPUT_DIR`, `SESSIONS_DIR`, `CHAINS_DIR` — hardcoded relative paths containing `../docs/...`
  and `../.kiro/...` anchored to the Scottish Water repo layout
- `CRAWL_JOBS_FILE`, `CLONE_JOBS_FILE`, `BUILD_QUEUE_FILE` — absolute paths via `path.join(WORKSPACE_ROOT, ...)`
- `KIRO_TOOLS_DIR`, `SPECS_DIR`, `PROMPT_OUTPUT_DIR` — absolute paths via `path.join`
- `WORKFLOW_DIR` — built from `process.env.APPDATA` (this is correct, kept as-is)

**Target state:**

```typescript
// src/constants.ts
import * as path from "path";
import { config } from "dotenv";
config();                              // loads .env before any process.env access

// resolveConstants is exported for property-based testing.
// Module-level exports below call it with the live process.env.
export function resolveConstants(env: NodeJS.ProcessEnv) {

  // Scalar constants (unchanged)
  const PORT              = Number(env.PORT) || 3333;
  const POLL_LOG_MAX      = 200;
  const SCAN_CACHE_TTL    = 5_000;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  // WORKFLOW_DIR — env-var driven; falls back to APPDATA-derived path when not set
  const _WORKFLOW_DIR_DEFAULT = path.join(
    env.APPDATA ?? "",
    "Kiro", "User", "globalStorage", "kiro.kiroagent",
    "c63f7a0d8b77479ab89f1bc6e7131b78", "414d1636299d2b9e4ce7e17fb11f63e9"
  );
  const WORKFLOW_DIR = env.WORKFLOW_DIR || _WORKFLOW_DIR_DEFAULT;

  // All engagement paths — env-var driven with defined fallbacks
  const WORKSPACE_ROOT      = env.WORKSPACE_ROOT      ?? "";
  const OUTPUT_DIR          = env.OUTPUT_DIR          ?? "";
  const SESSIONS_DIR        = env.SESSIONS_DIR        ?? "";
  const CHAINS_DIR          = env.CHAINS_DIR          || SESSIONS_DIR;
  const SPECS_DIR           = env.SPECS_DIR           ?? "";
  const PROMPT_OUTPUT_DIR   = env.PROMPT_OUTPUT_DIR   || OUTPUT_DIR;
  const CRAWL_JOBS_FILE     = env.CRAWL_JOBS_FILE     ?? "docs/reference/.crawl-queue.json";
  const CLONE_JOBS_FILE     = env.CLONE_JOBS_FILE     ?? "docs/reference/.clone-queue.json";
  const BUILD_QUEUE_FILE    = env.BUILD_QUEUE_FILE    ?? "docs/reference/.build-queue.json";
  const KIRO_TOOLS_DIR      = env.KIRO_TOOLS_DIR      ?? "";

  return {
    PORT, POLL_LOG_MAX, SCAN_CACHE_TTL, SHUTDOWN_TIMEOUT_MS,
    WORKFLOW_DIR, WORKSPACE_ROOT, OUTPUT_DIR, SESSIONS_DIR,
    CHAINS_DIR, SPECS_DIR, PROMPT_OUTPUT_DIR, CRAWL_JOBS_FILE,
    CLONE_JOBS_FILE, BUILD_QUEUE_FILE, KIRO_TOOLS_DIR,
  };
}

// Module-level named exports (used by all production code)
const _resolved = resolveConstants(process.env);
export const PORT              = _resolved.PORT;
export const POLL_LOG_MAX      = _resolved.POLL_LOG_MAX;
export const SCAN_CACHE_TTL    = _resolved.SCAN_CACHE_TTL;
export const SHUTDOWN_TIMEOUT_MS = _resolved.SHUTDOWN_TIMEOUT_MS;
export const WORKFLOW_DIR      = _resolved.WORKFLOW_DIR;
export const WORKSPACE_ROOT    = _resolved.WORKSPACE_ROOT;
export const OUTPUT_DIR        = _resolved.OUTPUT_DIR;
export const SESSIONS_DIR      = _resolved.SESSIONS_DIR;
export const CHAINS_DIR        = _resolved.CHAINS_DIR;
export const SPECS_DIR         = _resolved.SPECS_DIR;
export const PROMPT_OUTPUT_DIR = _resolved.PROMPT_OUTPUT_DIR;
export const CRAWL_JOBS_FILE   = _resolved.CRAWL_JOBS_FILE;
export const CLONE_JOBS_FILE   = _resolved.CLONE_JOBS_FILE;
export const BUILD_QUEUE_FILE  = _resolved.BUILD_QUEUE_FILE;
export const KIRO_TOOLS_DIR    = _resolved.KIRO_TOOLS_DIR;
```

**Design decisions:**

- `resolveConstants(env)` is a pure factory function that accepts any `NodeJS.ProcessEnv`-shaped object. This makes Property 3 directly testable without module cache invalidation — property tests call `resolveConstants({ OUTPUT_DIR: "...", ... })` directly. Module-level exports call it once with `process.env` at load time, preserving all existing import semantics.
- Bun has built-in `.env` auto-loading that fires before any user code runs — it does NOT require an explicit `dotenv.config()` call. However, this migration uses the `dotenv` npm package's `config()` call explicitly for two reasons: (1) it makes the load point unambiguous and auditable in the source — `config()` as the first statement is a clear contract; (2) it works identically in Node.js environments if AgentHQ is ever run outside Bun. The `dotenv` package is already in `devDependencies`. Bun's auto-load and the explicit `config()` call are both idempotent — loading `.env` twice is safe; the second load is a no-op for already-set variables (dotenv's default behaviour). No double-load risk exists in practice. **Dependency classification note:** `dotenv` is currently in `devDependencies`. This is acceptable as long as AgentHQ is always run in a development context (i.e. using `bun run src/monitor.ts` directly). If AgentHQ is ever packaged for distribution or run via a compiled binary, `dotenv` must be moved to `dependencies` — otherwise the runtime `require('dotenv')` call will fail in a production install. This constraint is noted in the README under Build Steps.
- **Fallback operator choice (`||` vs `??`)**: `CHAINS_DIR` and `PROMPT_OUTPUT_DIR` use `||` (logical OR) rather than `??` (nullish coalescing) for their fallback chains. This is intentional:
  - `??` only triggers fallback for `null` or `undefined` — an empty string `""` from `.env` would pass through unchanged
  - `||` triggers fallback for any falsy value — including empty strings, matching the "absent or empty" language in Requirements 3.4 and 3.8
  - **Example**: `CHAINS_DIR=` in `.env` (empty string) → with `??`, `CHAINS_DIR` resolves to `""` even though `SESSIONS_DIR` is configured; with `||`, `CHAINS_DIR` correctly falls back to `SESSIONS_DIR`
  - The requirements document uses `??` in example expressions, but this is a **corrected divergence** for semantic correctness
  - **Maintainer note**: Do NOT replace `||` with `??` in fallback chains — this would break the "absent or empty" contract
- `PROMPT_OUTPUT_DIR` falls back to `OUTPUT_DIR` by the same pattern and for the same
  reason (`||` handles empty strings; `??` would not).
- `CRAWL_JOBS_FILE`, `CLONE_JOBS_FILE`, `BUILD_QUEUE_FILE` retain string-literal defaults
  because they are relative paths used as fallback examples, not engagement-specific
  absolute paths. Requirement 3.12 prohibits absolute paths and engagement-specific
  relative paths — generic queue file locations inside `docs/reference/` are acceptable
  defaults. Note: these defaults appear on the RHS of `??` inside a `process.env`
  fallback expression, which is the explicit carve-out permitted by Req 3.12.
- `KIRO_TOOLS_DIR` has no default (falls back to `""`) — it is an optional directory and no startup warning is emitted when absent. Callers that use `KIRO_TOOLS_DIR` must guard against empty strings themselves.
- **Dependency classification note (resolved):** `dotenv` is moved from `devDependencies` to `dependencies` in `package.json` to support potential future packaging scenarios. A `prepack` script guards against accidental distribution without this change. The script emits an error if `bun pack` or `npm pack` is attempted and `dotenv` is not in `dependencies`.

### Startup Path Validation (`src/monitor.ts`)

A validation block is inserted at the very top of `monitor.ts`, **before any worker module imports and before `Bun.serve()`**, so that warnings are emitted and the process terminates before reaching a request-accepting state. Worker modules are imported lazily (inside the `if (valid)` guard below) to prevent any import-level side effects from firing before `process.exit(1)`.

```typescript
// src/monitor.ts — startup validation (inserted before any worker imports)
// NOTE: This file is always the entry point — do not import it from other modules.
// The validation block below executes at import time; importing monitor.ts from another
// module would trigger process.exit(1) if the environment is not configured.
import { findUnconfiguredVars, validateEnvPaths } from './validation.ts';
import { OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT, WORKFLOW_DIR } from './constants.ts';

// Step 1: check all required vars are non-empty
const envConfig = { OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT };
const unconfigured = findUnconfiguredVars(envConfig);
for (const name of unconfigured) {
  console.warn(`[WARNING] ${name} is not configured. Set it in .env before starting AgentHQ.`);
}
if (unconfigured.length > 0) {
  process.exit(1);
}

// Step 2: check all required paths exist on disk
const missingPaths = validateEnvPaths(envConfig);
for (const name of missingPaths) {
  console.warn(`[WARNING] ${name} path does not exist: ${envConfig[name as keyof typeof envConfig]}`);
}
if (missingPaths.length > 0) {
  process.exit(1);
}

// Step 3: detect unexpanded Windows env-var syntax in WORKFLOW_DIR
// WORKFLOW_DIR is optional (has APPDATA fallback) so it is not in Step 1/2.
// But if it IS set and contains a literal %, dotenv did not expand it — catch this early.
if (WORKFLOW_DIR.includes('%')) {
  console.warn(`[WARNING] WORKFLOW_DIR contains unexpanded Windows variable syntax (%): "${WORKFLOW_DIR}". ` +
    `dotenv does not expand %VAR% — expand to an absolute path in .env.`);
  process.exit(1);
}

// Worker imports only reached when all required vars are configured and paths exist
const { startWorkers } = await import('./workers/index.ts');
```

**Design decisions:**

- `findUnconfiguredVars` and `validateEnvPaths` live in `src/validation.ts`, a side-effect-free module. Tests import it directly without starting the server. The `monitor.ts` file no longer contains inline validation logic — it delegates entirely to `validation.ts`.
- Startup validation runs in **two sequential steps**: (1) `findUnconfiguredVars` checks for absent/empty vars and emits warnings for each; (2) `validateEnvPaths` checks that all configured paths exist on disk. Both steps emit per-variable warnings before calling `process.exit(1)`. This satisfies both Req 4 (unconfigured vars) and Req 5.5 (path existence check before accepting connections).
- `validateEnvPaths` now returns `string[]` (the list of variable names whose paths are missing or non-existent) rather than `boolean`. This mirrors `findUnconfiguredVars` and eliminates the redundant second `fs.existsSync` loop that was previously in `monitor.ts`. The injectable `pathExists` parameter (defaults to `fs.existsSync`) remains so Property 6 tests can pass a fake without real I/O.
- All warnings are emitted in a single loop before `process.exit(1)`, ensuring every
  unconfigured variable is reported even when multiple are missing (satisfies Req 4.4).
- Worker modules are imported *after* both validation guards. Bun's dynamic `import()` is used so that no worker code runs (including any module-level timers or pollers) unless all required variables pass validation. **Pre-condition:** all modules under `src/workers/` must have no top-level side effects (no timers, file watchers, or event emitters at module scope). This is verified during Phase 9: `tsc --noEmit` confirms the import structure is valid, and the smoke tests confirm the server does not produce output or accept connections before validation completes. If a future worker module introduces top-level side effects, the lazy import pattern here will prevent them from firing during startup validation — which may cause subtle behaviour differences between the validated and unvalidated code paths. This constraint is documented in `workspace/.kiro/steering/tech-core.md` under the Module Structure section.
- The check runs after `import` (which triggers `constants.ts` → `dotenv.config()`)
  so `.env` is always loaded before the validation.
- **`WORKFLOW_DIR` misconfiguration detection:** `WORKFLOW_DIR` is not in the required-var list (it has an APPDATA-derived fallback), so an absent or empty `WORKFLOW_DIR` does not trigger a startup warning. However, if `WORKFLOW_DIR` is *set* but contains a literal `%` character (e.g. copied from `scottishwater.env` without expanding `%APPDATA%`), the server would silently use an invalid path that looks valid (non-empty string). To catch this, a third validation step is added:
  ```typescript
  // Step 3: detect unexpanded Windows env-var syntax in WORKFLOW_DIR
  if (WORKFLOW_DIR.includes('%')) {
    console.warn(`[WARNING] WORKFLOW_DIR contains unexpanded Windows variable syntax (%): "${WORKFLOW_DIR}". ` +
      `dotenv does not expand %VAR% — expand to an absolute path in .env.`);
    process.exit(1);
  }
  ```
  This check runs only when `WORKFLOW_DIR` is non-empty (the empty case falls back to the APPDATA default silently, which is correct behaviour).
- The existing startup log line `console.log(\`Monitor server running on http://localhost:${server.port}\`)` 
  is renamed to match the required branding: 
  `console.log(\`AgentHQ running at http://localhost:${server.port}\`)` 
  (satisfies Req 2.6).
- The validation block does not interfere with the existing graceful-shutdown logic
  (`waitForDrain`) or SSE broadcaster, which run only after the server is initialised.

---

### `.env` / `.env.example` Design

**`.env.example`** (committed to git):

```dotenv
# AgentHQ — environment configuration
# Copy this file to .env and fill in the paths for your engagement.

# HTTP port the monitor server listens on (default: 3333)
PORT=3333

# Absolute path to the directory where prompt output files are written
OUTPUT_DIR=

# Absolute path to the directory where Kiro session JSON files are stored
SESSIONS_DIR=

# Absolute path to the directory where session chain files are stored
# Falls back to SESSIONS_DIR if not set
CHAINS_DIR=

# Absolute path to the workflow execution directory used by the Kiro agent
WORKFLOW_DIR=

# Absolute path to the root of the workspace being monitored
WORKSPACE_ROOT=

# Absolute path to the Kiro specs directory
SPECS_DIR=

# Absolute path to the prompt output directory (falls back to OUTPUT_DIR)
PROMPT_OUTPUT_DIR=

# Path to the crawl jobs queue file (relative to WORKSPACE_ROOT, or absolute)
CRAWL_JOBS_FILE=docs/reference/.crawl-queue.json

# Path to the clone jobs queue file (relative to WORKSPACE_ROOT, or absolute)
CLONE_JOBS_FILE=docs/reference/.clone-queue.json

# Path to the build queue file (relative to WORKSPACE_ROOT, or absolute)
BUILD_QUEUE_FILE=docs/reference/.build-queue.json

# Absolute path to the Kiro tools directory containing PowerShell scripts
KIRO_TOOLS_DIR=
```

**`docs/examples/scottishwater.env`** (committed reference):

This file documents the concrete values used for the Scottish Water engagement.
It is never loaded at runtime — it exists solely as documentation.

```dotenv
# Scottish Water engagement — reference .env values
# Copy relevant values to .env in your agenthq repo root.

PORT=3333
OUTPUT_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater\docs\analysis\prompts\output
SESSIONS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater\.kiro\sessions
CHAINS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater\.kiro\sessions
# Note: %APPDATA% is Windows cmd syntax — expand manually when copying to .env
# WARNING: %APPDATA% below is Windows cmd syntax — dotenv does NOT expand it.
# Expand to an absolute path before copying to .env, e.g.:
# WORKFLOW_DIR=C:\Users\Admin\AppData\Roaming\Kiro\User\globalStorage\kiro.kiroagent\c63f7a0d8b77479ab89f1bc6e7131b78\414d1636299d2b9e4ce7e17fb11f63e9
WORKFLOW_DIR=%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\c63f7a0d8b77479ab89f1bc6e7131b78\414d1636299d2b9e4ce7e17fb11f63e9
WORKSPACE_ROOT=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater
SPECS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater\.kiro\specs
PROMPT_OUTPUT_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater\docs\analysis\prompts\output
KIRO_TOOLS_DIR=C:\Users\Admin\OneDrive - PBT Group\Repos\cdannhauser-inspiredtesting\ScottishWater\.kiro\tools
```

> **Warning:** `%APPDATA%` in `scottishwater.env` is Windows cmd shell syntax. The `dotenv` package does **not** expand `%VAR%` syntax — if copied as-is, `WORKFLOW_DIR` will be set to the literal string `%APPDATA%\...`, which is an invalid path. Because `WORKFLOW_DIR` has no startup warning (it falls back to the APPDATA-derived default), this misconfiguration is **silent** — the server will start but use the fallback path rather than the intended one. Always expand `%APPDATA%` to its absolute value (e.g. `C:\Users\Admin\AppData\Roaming`) before copying to `.env`. A comment warning is included in the reference file itself.

---

### `.gitignore` Design

```gitignore
# Dependencies and build output
node_modules/
.venv/
dist/
__pycache__/
*.pyc

# Environment / secrets
.env
.env.local
.env.*.local
!.env.example

# Runtime state files
.poll-state.json
.summarise-state.json

# Kiro memory graph (per-machine, not versioned)
workspace/.kiro/memory/graph.json
```

**Design rationale for `.env` / `!.env.example` ordering:**
The `!.env.example` negation must appear _after_ the `.env` pattern. If it were placed
before, git would first include `.env.example` (default), then exclude `.env*` (which
matches `.env.example`), and the negation would never fire. The ordering `\n.env\n!.env.example`
is the standard gitignore idiom for this use case.


---

### `README.md` Structure (Template-Based Generation)

The `README.md` generated in Phase 7 is read from `migrate-templates/README.md.template` rather than constructed inline. This avoids PowerShell here-string escaping issues with nested code fences.

**Template structure** (migrate-templates/README.md.template):

````markdown
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
````

**Phase 7 implementation:**

```powershell
$currentPhase = "7"

$readmeContent = Read-Template "README.md.template"
Set-Content -Path "$DEST\README.md" -Value $readmeContent

Write-Host "[Phase 7] Generated README.md from template"
```

The template file approach eliminates escaping complexity and makes content updates easier — edit the markdown file directly rather than modifying PowerShell string literals.

---

### `workspace/` Directory Structure

The `workspace/` directory is committed to git and contains the full Kiro workspace
configuration for the AgentHQ repo itself.

```
workspace/
├── agenthq.code-workspace       ← opens the repo root in Kiro/VSCode
└── .kiro/
    ├── steering/
    │   ├── tech-core.md         ← AgentHQ tech stack, module map, key commands, skills index
    │   ├── agent-batching.md    ← copied from SW workspace (rate-limit batching rules)
    │   └── task-concurrency.md ← copied from SW workspace (sequential subagent rules)
    ├── skills/
    │   ├── agenthq-dashboard/
    │   │   └── SKILL.md         ← renamed from sw-monitor-dashboard, paths rewritten
    │   ├── accelint-ts-best-practices/
    │   ├── accelint-ts-testing/
    │   ├── accelint-ts-performance/
    │   ├── accelint-ts-documentation/
    │   ├── typescript-advanced-types/
    │   ├── javascript-testing-patterns/
    │   ├── modern-javascript-patterns/
    │   ├── debugging-strategies/
    │   ├── error-handling-patterns/
    │   ├── frontend-design/
    │   ├── design-system-patterns/
    │   ├── interaction-design/
    │   ├── responsive-design/
    │   ├── ux-design-systems/
    │   ├── visual-design-foundations/
    │   ├── accessibility/
    │   ├── improve-codebase-architecture/
    │   ├── diagnose/
    │   ├── best-practices/
    │   └── memory-consolidation/
    ├── powers/
    │   └── agenthq-memory/
    │       └── mcp.json         ← memory MCP server pointing at graph.json in this repo
    ├── specs/                   ← migrated from SW repo
    │   ├── monitor-dashboard-redesign/
    │   └── monitor-server-split/
    └── memory/
        └── .gitkeep             ← ensures memory/ dir is committed; graph.json is gitignored
```

**`agenthq.code-workspace`:**
```json
{
  "folders": [
    { "path": ".." }
  ]
}
```

Opening this file in Kiro or VSCode loads the repo root as the workspace, making all
steering files, skills, and powers available to the agent.

**Phase 5 — Workspace population using template file:**

Phase 5 reads `tech-core.md` content from `migrate-templates/tech-core.md.template` rather than an inline here-string. The template uses `{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}` as a placeholder that is replaced at generation time:

```powershell
$currentPhase = "5"

# Read template and substitute placeholders
$techCoreTemplate = Read-Template "tech-core.md.template"
$techCoreContent = $techCoreTemplate -replace '{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}', $MEMORY_SERVER_DEFAULT_PATH_NOTE

Set-Content -Path "$DEST\workspace\.kiro\steering\tech-core.md" -Value $techCoreContent
Write-Host "[Phase 5] Generated workspace/.kiro/steering/tech-core.md from template"

# Copy steering files from SW workspace
Copy-Item ".kiro\steering\agent-batching.md" "$DEST\workspace\.kiro\steering\" -Force
Copy-Item ".kiro\steering\task-concurrency.md" "$DEST\workspace\.kiro\steering\" -Force

# Copy skills...
# (existing skill copy logic)
```

**Template file location:** `migrate-templates/tech-core.md.template` is a markdown file stored alongside `migrate.ps1`. This separates content from script logic and eliminates PowerShell here-string escaping issues.

**`workspace/.kiro/powers/agenthq-memory/mcp.json`:**

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "C:\\Users\\Admin\\AppData\\Roaming\\npm\\node_modules\\@modelcontextprotocol\\server-memory\\dist\\index.js"
      ],
      "env": {
        "MEMORY_FILE_PATH": "C:\\repos\\corneldann\\agenthq\\workspace\\.kiro\\memory\\graph.json"
      },
      "disabled": false,
      "autoApprove": [
        "search_nodes",
        "open_nodes",
        "read_graph"
      ]
    }
  }
}
```

No Oracle, pbixray, or Power BI entries are included — this power is AgentHQ-only.

---

### Name Replacement Strategy

All `agenthq` / `AgentHQ` strings are replaced in a targeted set of files.
The migration script performs these replacements explicitly rather than running a
global search-and-replace, to avoid corrupting binary files or history.

| File | From | To |
|------|------|----|
| `package.json` | `"name": "agenthq"` | `"name": "agenthq"` |
| `package.json` | existing description | `"AgentHQ — developer agent monitor and dashboard"` |
| `package.json` | `"agenthq": "src/cli.ts"` in `bin` | `"agenthq": "src/cli.ts"` |
| `src/dashboard/index.html` | `<title>AgentHQ Monitor</title>` | `<title>AgentHQ</title>` |
| `src/monitor.ts` | startup log string | `AgentHQ running at http://localhost:` |
| `workspace/.kiro/skills/agenthq-dashboard/SKILL.md` | `sw-monitor-dashboard` in front-matter `name:` | `agenthq-dashboard` |
| `workspace/.kiro/skills/agenthq-dashboard/SKILL.md` | all `agenthq/src/dashboard/` | `src/dashboard/` |
| `workspace/.kiro/skills/agenthq-dashboard/SKILL.md` | all `AgentHQ Monitor` | `AgentHQ` |
| `workspace/.kiro/steering/tech-core.md` | all `sw-monitor-dashboard` | `agenthq-dashboard` |
| `workspace/.kiro/steering/tech-core.md` | all `agenthq/` path references | `src/` equivalents |

The PowerShell replacement uses `(Get-Content $file) -replace 'pattern','replacement' | Set-Content $file`
for text files. Binary files (if any) are excluded from the replacement pass.

After replacement, the script runs a verification grep:
```powershell
$hits = Select-String -Path "$DEST\src" -Pattern "agenthq|AgentHQ" -Recurse
if ($hits) { Fail "Name replacement incomplete: found prohibited strings in src/" }
```

### Scottish Water Handover (Phase 10 — Enhanced)

Phase 10 modifies the Scottish Water workspace. To reduce risk of data loss, several enhancements are added:

**Pre-handover verification:**
```powershell
$currentPhase = "10"

# Verify Phase 9 completed successfully
if ($phase9Failed) {
    Fail "Phase 9 verification incomplete — Phase 10 will not execute."
}

# Verify SW workspace is clean (no uncommitted changes to files we'll modify)
Write-Progress-Step "Phase 10" "Verifying Scottish Water workspace state..."

$swStatus = git status --porcelain .kiro/steering/tech-core.md 2>&1
if ($swStatus.Length -gt 0) {
    Fail "Scottish Water workspace has uncommitted changes to .kiro/steering/tech-core.md. Commit or stash before handover."
}

# Verify grep patterns against actual files before modification
Write-Progress-Step "Phase 10" "Pre-verifying grep patterns..."

$testHits = Select-String -Path ".kiro\steering\tech-core.md" -Pattern "sw-monitor-dashboard|agenthq/" 2>&1
if (-not $testHits) {
    Write-Warning "Pre-verification: No matches found for 'sw-monitor-dashboard' or 'agenthq/' in tech-core.md"
    Write-Warning "This may indicate the file has already been migrated, or the patterns are incorrect."
    
    $continue = Read-Host "Continue with handover anyway? (y/N)"
    if ($continue -ne 'y') {
        Fail "Handover cancelled by user after grep pre-verification warning."
    }
}
```

**SW tech-core.md rewrite with verified patterns:**
```powershell
Write-Progress-Step "Phase 10" "Updating Scottish Water tech-core.md..."

# Read current content
$swTechCore = Get-Content ".kiro\steering\tech-core.md" -Raw

# Apply replacements
$swTechCore = $swTechCore -replace 'sw-monitor-dashboard', 'agenthq-dashboard'
$swTechCore = $swTechCore -replace 'agenthq/src/dashboard/', 'src/dashboard/'
$swTechCore = $swTechCore -replace 'agenthq/', ''  # Remove remaining agenthq/ path references

# Write back
Set-Content -Path ".kiro\steering\tech-core.md" -Value $swTechCore

# Verify replacement was successful
Assert-NoMatch -Path ".kiro\steering\" -Pattern "agenthq|sw-monitor-dashboard" `
    -Description "SW tech-core.md handover"
```

**Spec migration with file-count guard:**
```powershell
Write-Progress-Step "Phase 10" "Migrating specs from SW workspace to AgentHQ..."

# Use the Copy-Spec helper function (defined in Helper Functions section)
Copy-Spec -SrcDir ".kiro\specs\monitor-dashboard-redesign" `
    -DestDir "$DEST\workspace\.kiro\specs\monitor-dashboard-redesign"

Copy-Spec -SrcDir ".kiro\specs\monitor-server-split" `
    -DestDir "$DEST\workspace\.kiro\specs\monitor-server-split"
```

**agenthq/ removal and commit:**
```powershell
Write-Progress-Step "Phase 10" "Removing agenthq/ from Scottish Water workspace..."

Remove-Item "agenthq\" -Recurse -Force

# Stage changes
git add -A

# Commit with conventional commits subject line
$commitMsg = "chore(agenthq): remove agenthq/ — extracted to corneldann/agenthq"
git commit -m $commitMsg

Write-Host "[Phase 10] Scottish Water handover complete"
```

**Key improvements:**
- Pre-handover verification of git status
- Grep pattern verification before modification (warns if patterns don't match)
- User confirmation if pre-verification warning is raised
- Structured progress output
- Reuses `Copy-Spec` and `Assert-NoMatch` helper functions

---

### Memory Graph Isolation Design

The Scottish Water workspace has its `memory` MCP server configured in
`.kiro/powers/oracle-carbon-analysis/mcp.json`. That config has **no** `env.MEMORY_FILE_PATH`
entry, meaning the server uses the `@modelcontextprotocol/server-memory` package default path
(`%APPDATA%\Local\...` or the package's own default).

The AgentHQ `workspace/.kiro/powers/agenthq-memory/mcp.json` sets:
```json
"env": { "MEMORY_FILE_PATH": "C:\\repos\\corneldann\\agenthq\\workspace\\.kiro\\memory\\graph.json" }
```

Isolation is enforced at the file-system level:
- Scottish Water memory server writes to its default path (unchanged).
- AgentHQ memory server writes to the explicitly configured path inside the AgentHQ repo.
- The two paths are different by construction (one is inside the SW repo or AppData; the other
  is `C:\repos\corneldann\agenthq\...`).
- `workspace/.kiro/memory/graph.json` is listed in `.gitignore`, so graph content is never
  committed to the AgentHQ repo.
- The `.gitkeep` file ensures the `memory/` directory exists in a fresh clone without needing
  the developer to create it manually.

If the installed version of `@modelcontextprotocol/server-memory` does not honour `MEMORY_FILE_PATH`,
the `workspace/.kiro/steering/tech-core.md` must contain a dedicated section titled
**"Memory Server — File Path Override"** documenting the actual default path used by that
package version, so the developer can manually separate the graphs.

**Pre-condition for Requirement 11.3 verification (resolved in Phase 0.5):**

**Runtime verification approach (Phase 9 with enhanced error handling):**

Requirement 11.3 requires runtime verification that `MEMORY_FILE_PATH` is honoured. Phase 9 includes timeout handling, cleanup on all paths, and port conflict detection:

```powershell
$currentPhase = "9"

# Phase 9.1 — TypeScript compilation
Write-Progress-Step "Phase 9" "Running TypeScript compiler..."
Set-Location $DEST
node_modules\.bin\tsc.exe --noEmit
if ($LASTEXITCODE -ne 0) { Fail "TypeScript compilation failed" }

# Phase 9.2 — bun install with timeout
Write-Progress-Step "Phase 9" "Running bun install (timeout: 300s)..."
Invoke-WithTimeout -TimeoutSeconds 300 -Description "bun install" -ScriptBlock {
    Set-Location $DEST
    bun install 2>&1
}

# Phase 9.3 — bun test
Write-Progress-Step "Phase 9" "Running test suite..."
bun test test/
if ($LASTEXITCODE -ne 0) { Fail "Test suite failed" }

# Phase 9.4 — Memory isolation runtime check with cleanup
Write-Progress-Step "Phase 9" "Verifying memory isolation (Req 11.3)..."

$testGraphPath = Join-Path $env:TEMP "agenthq-test-graph-$(Get-Date -Format 'yyyyMMddHHmmss').json"
$memServerJs = "$env:APPDATA\npm\node_modules\@modelcontextprotocol\server-memory\dist\index.js"

try {
    $env:MEMORY_FILE_PATH = $testGraphPath
    
    # Start memory server briefly
    $serverProcess = Start-Process -FilePath "node" -ArgumentList $memServerJs `
        -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\mem-test-stdout.log" `
        -RedirectStandardError "$env:TEMP\mem-test-stderr.log"
    
    # Wait for file creation (2 second timeout)
    $waited = 0
    while (-not (Test-Path $testGraphPath) -and $waited -lt 2000) {
        Start-Sleep -Milliseconds 100
        $waited += 100
    }
    
    # Stop server
    if (-not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Verify file was created
    if (-not (Test-Path $testGraphPath)) {
        Fail "[Req 11.3] MEMORY_FILE_PATH env var not honoured by installed server-memory version. " +
             "See workspace/.kiro/steering/tech-core.md — 'Memory Server — File Path Override' section. " +
             "Resolve graph path conflict manually before re-running Phase 9."
    }
    
    Write-Progress-Step "Phase 9" "Req 11.3 verified: MEMORY_FILE_PATH is honoured"
    
} finally {
    # Cleanup: always remove test file and env var
    if (Test-Path $testGraphPath) {
        Remove-Item $testGraphPath -Force -ErrorAction SilentlyContinue
    }
    Remove-Item env:MEMORY_FILE_PATH -ErrorAction SilentlyContinue
    
    # Cleanup temp logs
    Remove-Item "$env:TEMP\mem-test-stdout.log" -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\mem-test-stderr.log" -Force -ErrorAction SilentlyContinue
}

# Phase 9.5 — HTTP smoke tests with port conflict handling
Write-Progress-Step "Phase 9" "Starting HTTP smoke tests..."

# Check if port 3333 is already in use
$portInUse = Get-NetTCPConnection -LocalPort 3333 -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Warning "Port 3333 is already in use. Smoke tests will use port 13333."
    $env:PORT = "13333"
    $testPort = 13333
} else {
    $testPort = 3333
}

try {
    # Start monitor server in background
    $monitorProcess = Start-Process -FilePath "bun" -ArgumentList "run", "src/monitor.ts" `
        -WorkingDirectory $DEST -NoNewWindow -PassThru `
        -RedirectStandardOutput "$env:TEMP\monitor-stdout.log" `
        -RedirectStandardError "$env:TEMP\monitor-stderr.log"
    
    # Wait for server to start (5 second timeout)
    Start-Sleep -Seconds 2
    
    # Test GET /
    $response = Invoke-WebRequest -Uri "http://localhost:$testPort/" -TimeoutSec 5 -ErrorAction Stop
    if ($response.StatusCode -ne 200) {
        Fail "HTTP smoke test failed: GET / returned $($response.StatusCode)"
    }
    Write-Progress-Step "Phase 9" "HTTP smoke test passed: GET / returned 200"
    
    # Test GET /events (SSE endpoint)
    $sseResponse = Invoke-WebRequest -Uri "http://localhost:$testPort/events" -TimeoutSec 5 -ErrorAction Stop
    if ($sseResponse.StatusCode -ne 200 -or $sseResponse.Headers.'Content-Type' -notlike '*text/event-stream*') {
        Fail "HTTP smoke test failed: GET /events did not return SSE stream"
    }
    Write-Progress-Step "Phase 9" "HTTP smoke test passed: GET /events returned SSE stream"
    
} catch {
    Fail "HTTP smoke tests failed: $($_.Exception.Message)"
} finally {
    # Stop monitor server
    if ($monitorProcess -and -not $monitorProcess.HasExited) {
        Stop-Process -Id $monitorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Cleanup
    Remove-Item env:PORT -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\monitor-stdout.log" -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\monitor-stderr.log" -Force -ErrorAction SilentlyContinue
}

Write-Host "[Phase 9] All verification steps passed"
```

**Key improvements:**
- Timeout handling for `bun install` (5 minute limit)
- Cleanup in `finally` blocks ensures temp files removed on all paths (success, failure, timeout)
- Port conflict detection — if 3333 is in use, tests use port 13333 instead
- Process cleanup — monitor server always stopped after smoke tests
- Structured progress output at each step

**Phase 9 → Phase 10 gate — explicit failure tracking:**
Phase 10 is gated on Phase 9 completing with zero failures. The script uses an explicit `$phase9Failed` boolean flag (set to `$true` by any Phase 9 `Fail` call before the Phase 9 scope exits) rather than relying solely on `$LASTEXITCODE`. This ensures that even a Phase 9 path that calls `Fail` and traps the exit (e.g., in a `try/catch`) still prevents Phase 10 from executing:

```powershell
$phase9Failed = $false
# ... all Phase 9 steps; each Fail call sets $phase9Failed = $true before exit 1 ...
if ($phase9Failed) { Fail "Phase 9 verification incomplete — Phase 10 will not execute." }
```


---

## Data Models

### Environment Variable Resolution Table

Each constant in `Constants_Module` follows one of three resolution patterns:

| Pattern | Example | Description |
|---------|---------|-------------|
| `env ?? ""` | `OUTPUT_DIR` | Returns env var or empty string; triggers startup warning if empty |
| `env \|\| SIBLING` | `CHAINS_DIR \|\| SESSIONS_DIR` | Falls back to another constant; empty string also triggers fallback |
| `env \|\| default` | `WORKFLOW_DIR \|\| <appdata-path>` | Falls back to computed default; empty string also triggers fallback |
| `env ?? "literal"` | `CRAWL_JOBS_FILE ?? "docs/..."` | Falls back to a generic relative path default; empty string is kept as-is |
| `Number(env) \|\| default` | `PORT` | Numeric with default |

The full resolution table:

| Export | Env var | Fallback | Startup warning? |
|--------|---------|----------|-----------------|
| `PORT` | `PORT` | `3333` (numeric) | No |
| `OUTPUT_DIR` | `OUTPUT_DIR` | `""` | Yes |
| `SESSIONS_DIR` | `SESSIONS_DIR` | `""` | Yes |
| `CHAINS_DIR` | `CHAINS_DIR` | `SESSIONS_DIR` | No (inherits from SESSIONS_DIR) |
| `WORKFLOW_DIR` | `WORKFLOW_DIR` | APPDATA-derived path | No |
| `WORKSPACE_ROOT` | `WORKSPACE_ROOT` | `""` | Yes |
| `SPECS_DIR` | `SPECS_DIR` | `""` | No |
| `PROMPT_OUTPUT_DIR` | `PROMPT_OUTPUT_DIR` | `OUTPUT_DIR` | No (inherits from OUTPUT_DIR) |
| `CRAWL_JOBS_FILE` | `CRAWL_JOBS_FILE` | `"docs/reference/.crawl-queue.json"` | No |
| `CLONE_JOBS_FILE` | `CLONE_JOBS_FILE` | `"docs/reference/.clone-queue.json"` | No |
| `BUILD_QUEUE_FILE` | `BUILD_QUEUE_FILE` | `"docs/reference/.build-queue.json"` | No |
| `KIRO_TOOLS_DIR` | `KIRO_TOOLS_DIR` | `""` | No (optional; callers guard against empty strings) |

### MCP Configuration Schema

The `agenthq-memory/mcp.json` file matches the `McpServers` schema expected by Kiro:

```typescript
interface McpConfig {
  mcpServers: Record<string, McpServer>;
}

interface McpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;  // includes MEMORY_FILE_PATH
  disabled: boolean;
  autoApprove: string[];
}
```

### Spec File Structure (post-handover)

After Phase 10, the Scottish Water specs are moved to the AgentHQ workspace:

```
workspace/.kiro/specs/
├── monitor-dashboard-redesign/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
└── monitor-server-split/
    ├── requirements.md
    ├── design.md
    └── tasks.md
```

File count parity between source and destination is verified before deletion.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Copy correctness — structure preservation and exclusion

*For any* source directory tree with any combination of excluded items (`node_modules`, `.venv`,
`dist`, `.poll-state.json`, `.summarise-state.json`) present at any nesting depth, after the
migration copy operation: (a) every non-excluded file from the source exists at the
corresponding path under the destination, (b) no excluded item appears anywhere under the
destination, and (c) the count of destination files equals the count of source files minus
the count of excluded files.

**Validates: Requirements 1.3, 1.4, 1.5**

### Property 2: Branding replacement completeness

*For any* file under `src/` in the migrated AgentHQ repository, scanning its content and
path components should find zero occurrences of the string `agenthq` or `AgentHQ`.

**Validates: Requirements 2.3, 2.4**

### Property 3: Constants resolution — env-var fallback correctness

*For any* combination of environment variables being set (to arbitrary non-empty strings)
or absent/empty, each constant exported by the Constants_Module resolves to its declared
fallback value: empty-string constants resolve to `""` when the env var is absent; chained
fallbacks (`CHAINS_DIR → SESSIONS_DIR`, `PROMPT_OUTPUT_DIR → OUTPUT_DIR`) resolve to the
current value of the fallback constant at the time of evaluation.

**Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11**

### Property 4: Startup validation — warnings emitted for every unconfigured required variable

*For any* non-empty subset of `{OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT}` set to absent or
empty strings, the Monitor_Server SHALL emit a WARNING-level log entry identifying each
unconfigured variable, emit all applicable warnings before taking any further action, and then
terminate with a non-zero exit code before reaching a request-accepting state. When all three
are set to non-empty strings, no WARNING-level log entries referencing those three variables
are emitted.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**

### Property 5: Startup log message format

*For any* valid port value `p`, when the Monitor_Server starts successfully, the startup log
output should contain the string `"AgentHQ running at http://localhost:" + String(p)`.

**Validates: Requirements 2.6**

### Property 6: Server accepts valid `.env`, rejects invalid `.env`

*For any* set of non-empty path values that point at existing directories, when those values
are written to a `.env` file and the Monitor_Server is started, the server starts successfully
with exit code 0. For any `.env` file that is absent, empty, or contains paths that do not
exist on the file system, the Monitor_Server exits with a non-zero exit code before accepting
connections.

**Implementation note:** To make this property testable without filesystem side-effects, the
path validation logic must be extracted into a pure function that accepts an injectable
`pathExists: (p: string) => boolean` parameter. The property test passes a fake implementation
(`(p) => existingPaths.has(p)`). The integration test uses the real `fs.existsSync`.

**Validates: Requirements 5.5**

---

## Error Handling

### Migration Script Error Handling

Every phase of `migrate.ps1` is wrapped in a `try/catch` block. The `Fail` function
centralises error reporting and always calls `exit 1`:

```powershell
$currentPhase = 0
function Fail([string]$msg) {
    Write-Error "MIGRATION FAILED (Phase $currentPhase): $msg"
    exit 1
}

# Example phase wrapper:
$currentPhase = 2
try {
    $result = robocopy $SOURCE $DEST /MIR /XD node_modules .venv dist /XF .poll-state.json ...
    if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with exit code $LASTEXITCODE" }
} catch {
    Fail $_.Exception.Message
}
```

Robocopy exit codes ≥ 8 indicate errors; codes 0–7 are success variants (0 = no change,
1 = files copied, 2 = extra files, 3 = both, etc.). The script treats anything ≥ 8 as a
hard failure.

> **Phase 9 → Phase 10 gate:** Phase 10 (Scottish Water handover) is gated on Phase 9 completing with exit code 0. The script checks `$LASTEXITCODE` after the final Phase 9 verification step; if any Phase 9 step returns a non-zero exit code, `Fail` is called and Phase 10 never executes. This ensures Requirement 10.7 (agenthq/ retained until handover is safe) is enforced by the script itself, not just by convention.

### Constants_Module — No Runtime Errors

The Constants_Module contains only `const` declarations. It never throws. Empty-string
fallbacks mean any caller that tries to use an unconfigured path will encounter an empty
string, which is caught at the application level (Monitor_Server startup validation) rather
than at module load time.

### Monitor_Server Startup Errors

- Missing required vars → `process.exit(1)` after all warnings are emitted
- dotenv load failure (`.env` file malformed) → dotenv logs a warning but does not throw;
  the constants will resolve to `""` and the startup validation will catch them
- TypeScript compiler errors → caught by `tsc --noEmit` during verification (Phase 9)

### Package Manager Failure (Phase 9)

If `bun install` exits with a non-zero code during Phase 9, the script calls `Fail` and
halts before any subsequent verification steps run:

```powershell
$currentPhase = 9
try {
    bun install 2>&1 | Tee-Object -Variable bunOutput
    if ($LASTEXITCODE -ne 0) { Fail "bun install failed (exit $LASTEXITCODE). Check network access and package registry." }
} catch {
    Fail $_.Exception.Message
}
```

Common causes (documented for the developer):
- No network access to the npm registry — retry after restoring connectivity
- Lockfile conflict — delete `bun.lockb` and re-run `bun install`
- Incompatible Bun version — check `package.json` `engines.bun` field

### Spec Migration File Count Mismatch

If the file count after a spec copy does not match the source, `Fail` is called immediately.
The source directory is NOT deleted until parity is confirmed. If deletion itself fails,
`Fail` is called again. No subsequent handover steps execute after any failure.

### Git Push (Phase 8)

The push uses `git push -u origin main` with no `--force` or `--force-with-lease` flag. This ensures a pre-existing remote with commits causes the push to be rejected rather than silently overwritten (satisfies Req 8.4).

---

## Testing Strategy

This feature is a migration and infrastructure operation. The primary deliverables are:
a PowerShell script, modified TypeScript files, committed configuration files, and a new
git repository. Property-based testing applies to the pure logic layers (constants
resolution, startup validation message formatting, copy operation correctness). All
infrastructure-level steps use integration or smoke tests.

### Unit Tests (example-based)

| Test | What it verifies | Req |
|------|-----------------|-----|
| `package.json` name field | equals `"agenthq"` | 2.1 |
| `package.json` description field | equals expected string | 2.2 |
| `package.json` `prepack` script | exits non-zero when invoked | dotenv guard |
| `package.json` dependencies | `dotenv` is in `dependencies` not `devDependencies` | design resolution |
| `index.html` title | contains `<title>AgentHQ</title>` | 2.5 |
| `.env.example` variable coverage | all 12 variables present with comments | 5.1–5.3 |
| `.gitignore` patterns | all required patterns present in correct order | 7.1–7.5 |
| `workspace/agenthq.code-workspace` | `folders[0].path == ".."` | 6.2 |
| `agenthq-memory/mcp.json` structure | `MEMORY_FILE_PATH` set, no Oracle/PBI entries | 6.8, 6.10 |
| Memory path isolation | AgentHQ path != SW path (case-insensitive) | 11.3 |
| README.md sections | contains quick-start, configuration reference, build steps | 2.7 |
| README.md code fences | all code fences properly closed (no escaping issues) | template design |
| `constants.ts` static analysis | zero hardcoded absolute paths outside process.env | 3.12 |
| dotenv load position | `config()` is first executable statement | 3.1 |
| `monitor.ts` entry-point guard comment | file contains do-not-import comment | design note |
| Template files exist | `tech-core.md.template` and `README.md.template` present | template design |
| Template placeholder syntax | `{{MEMORY_SERVER_DEFAULT_PATH_NOTE}}` present in template | template design |

### Property-Based Tests (`test/`)

Property tests use **fast-check** (already in `devDependencies`) and are configured to
run a minimum of 100 iterations per property. Each test is tagged with a comment referencing
its design property.

```typescript
// Tag format: Feature: agenthq-migration, Property N: <property_text>
```

**Property 1 — Copy correctness (PowerShell logic, mocked fs):**
Tested via a pure TypeScript helper that models the copy/exclude decision:
```
// Feature: agenthq-migration, Property 1: copy preserves structure and respects exclusions
fc.property(fc.array(fc.string()), (paths) => {
  const result = applyExclusions(paths, EXCLUSION_LIST);
  // No excluded name appears in result
  // All non-excluded paths appear in result
})
```

> The `applyExclusions(paths, exclusionList)` helper is defined in `test/helpers/copy-exclusions.ts`. It accepts a flat list of file path strings and an exclusion config object `{ dirs: string[], files: string[] }`, and returns the subset of paths that robocopy would copy (i.e., paths not matching any excluded directory segment or filename). This helper is pure TypeScript with no PowerShell dependency, making it directly testable with fast-check.

**Property 3 — Constants resolution:**
```typescript
// Feature: agenthq-migration, Property 3: env-var fallback correctness
import { resolveConstants } from '../src/constants.ts';

fc.property(
  fc.option(fc.string({ minLength: 1 })),  // OUTPUT_DIR
  fc.option(fc.string({ minLength: 1 })),  // SESSIONS_DIR
  fc.option(fc.string({ minLength: 1 })),  // CHAINS_DIR
  (outputDir, sessionsDir, chainsDir) => {
    const env = {
      OUTPUT_DIR: outputDir ?? undefined,
      SESSIONS_DIR: sessionsDir ?? undefined,
      CHAINS_DIR: chainsDir ?? undefined,
    } as NodeJS.ProcessEnv;
    const c = resolveConstants(env);
    // CHAINS_DIR falls back to resolved SESSIONS_DIR when absent or empty
    if (!chainsDir) {
      expect(c.CHAINS_DIR).toBe(c.SESSIONS_DIR);
    }
  }
);
```

**Property 4 — Startup validation:**
```typescript
// Feature: agenthq-migration, Property 4: startup warns for every unconfigured required var
import { findUnconfiguredVars } from '../src/validation.ts';

fc.property(
  fc.subarray(['OUTPUT_DIR', 'SESSIONS_DIR', 'WORKSPACE_ROOT'] as const),
  (missingVars) => {
    const env = {
      OUTPUT_DIR: missingVars.includes('OUTPUT_DIR') ? '' : '/some/path',
      SESSIONS_DIR: missingVars.includes('SESSIONS_DIR') ? '' : '/some/path',
      WORKSPACE_ROOT: missingVars.includes('WORKSPACE_ROOT') ? '' : '/some/path',
    };
    const unconfigured = findUnconfiguredVars(env);
    // Every missing var must appear in the unconfigured list
    for (const v of missingVars) {
      expect(unconfigured).toContain(v);
    }
    // No false positives — configured vars must not appear
    const configured = ['OUTPUT_DIR','SESSIONS_DIR','WORKSPACE_ROOT']
      .filter(v => !missingVars.includes(v as any));
    for (const v of configured) {
      expect(unconfigured).not.toContain(v);
    }
  }
);
```

**Test stub for Property 5 — Startup log format:**
```
// Feature: agenthq-migration, Property 5: startup log message format
fc.property(fc.integer({ min: 1024, max: 65535 }), (port) => {
  const msg = formatStartupLog(port);
  expect(msg).toContain(`AgentHQ running at http://localhost:${port}`);
})
```

**Test stub for Property 6 — Server accepts/rejects .env:**
Tested by importing alidateEnvPaths from src/validation.ts with a fake pathExists:
```typescript
// Feature: agenthq-migration, Property 6: server accepts valid .env, rejects invalid
import { validateEnvPaths } from '../src/validation.ts';

const existingPaths = fc.array(fc.string({ minLength: 1 }), { minLength: 3, maxLength: 3 });

// All required paths exist → valid
fc.property(existingPaths, ([a, b, c]) => {
  const env = { OUTPUT_DIR: a, SESSIONS_DIR: b, WORKSPACE_ROOT: c };
  const fakeExists = (p: string) => [a, b, c].includes(p);
  expect(validateEnvPaths(env, fakeExists)).toHaveLength(0);
});

// At least one path absent/empty → invalid
fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
  const env = { OUTPUT_DIR: a, SESSIONS_DIR: b, WORKSPACE_ROOT: '' };
  const fakeExists = (p: string) => p.length > 0;
  expect(validateEnvPaths(env, fakeExists).length).toBeGreaterThan(0);
});
```

### Integration Tests

| Test | What it verifies | Req |
|------|-----------------|-----|
| `bun install` exits 0 | dependencies install cleanly | 9.1 |
| `tsc --noEmit` exits 0 | zero TypeScript errors | 9.2, 3.13 |
| `bun test test/` all pass | full test suite green | 9.3 |
| `GET /` returns 200 text/html | dashboard SPA served | 9.4 |
| `GET /events` returns 200 text/event-stream | SSE endpoint live | 9.6 |
| `GET /git-status` returns 200 JSON with branch + files | git route functional | 9.7 |
| `git show --stat HEAD` includes .env.example, .gitignore, README.md | initial commit contents | 8.1 |

### Smoke Tests (Phase 10)

These run after Phase 10 (Scottish Water handover) is fully complete:

| Test | What it verifies | Req |
|------|-----------------|-----|
| Monitor starts without `.env` → exits non-zero before accepting connections | missing .env handled | 4.4, 9.5 |
| Monitor starts with valid `.env` → no WARNING lines in output | correct startup | 4.5 |
| Monitor starts with `WORKFLOW_DIR=%APPDATA%\...` → exits non-zero with WARNING | unexpanded % detected | 2.6 design note |
| `git log --oneline` shows exactly 1 commit | single initial commit | 8.5 |
| `workspace/.kiro/memory/graph.json` is git-ignored | memory not tracked | 6.9 |
| `grep -r "agenthq\|sw-monitor-dashboard" .kiro/steering/` returns 0 matches | SW handover complete | 10.1 |
| Phase 9 Req 11.3 smoke passes (hard failure if `MEMORY_FILE_PATH` not honoured) | memory isolation enforced | 11.3 |
| Phase 10 pre-verification detects uncommitted changes | SW workspace guard | Phase 10 design |
| Phase 10 grep pre-verification runs before modification | pattern validation | Phase 10 design |
| Helper function `Copy-WithValidation` validates both count and structure | copy correctness | Phase 2 design |
| Helper function `Invoke-WithTimeout` terminates long-running commands | timeout handling | Phase 9 design |
| Helper function `Read-Template` reads template files correctly | template system | Phase 5, 7 design |

### Test Execution Order

Tests run in this order (wave-based, as per the project's sequential subagent constraint):

1. Unit tests — fast, no external dependencies
2. Property tests — fast, in-memory, uses mocked file system and env
3. Integration tests — requires `bun install` to have completed; server tests require a
   running Monitor_Server with valid `.env`
4. Smoke tests — run last; require the full migration to be complete

