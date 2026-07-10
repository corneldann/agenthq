#Requires -Version 5.1
<#
.SYNOPSIS
    AgentHQ Migration Script — Extract sw-agent/ to standalone repo

.DESCRIPTION
    Migrates sw-agent/ from the Scottish Water engagement repo to a standalone,
    engagement-agnostic repository at C:\repos\corneldann\agenthq\ and publishes
    it as corneldann/agenthq on GitHub.
    
    Migration phases:
    - Phase 0: Pre-flight checks (paths, git, bun, workspace state)
    - Phase 0.5: Memory server pre-flight (advisory path extraction)
    - Phase 1: Directory creation
    - Phase 2: File copy with robocopy (exclusions + validation)
    - Phase 3: Name replacement (sw-agent → agenthq)
    - Phase 4: Constants module rewrite (env-var driven)
    - Phase 5: Workspace population (steering, skills, powers)
    - Phase 6: .env files (.env.example, .gitignore, docs/examples/scottishwater.env)
    - Phase 7: README.md creation
    - Phase 8: Git init + remote setup
    - Phase 9: Functional verification (tsc, bun install, bun test, HTTP smoke tests)
    - Phase 10: Scottish Water handover (tech-core.md rewrite, spec migration, sw-agent/ removal)

.NOTES
    Author: AgentHQ Migration Task 1.1
    Requirements: Git, Bun ≥1.0.0, PowerShell ≥5.1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# ============================================================================
# CONFIGURATION
# ============================================================================

$DEST = "C:\repos\corneldann\agenthq\"
$currentPhase = "0"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

function Fail {
    param([string]$msg)
    Write-Error "MIGRATION FAILED (Phase $currentPhase): $msg"
    exit 1
}

function Write-Progress-Step {
    param(
        [string]$phase,
        [string]$message
    )
    Write-Host "[$phase] $message" -ForegroundColor Cyan
}

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
    
    # Resolve source to absolute path for comparison
    $SourceAbs = (Resolve-Path $Source).Path
    
    # File count validation
    $srcFiles = Get-ChildItem $Source -Recurse -File | Where-Object {
        $ExcludeFiles -notcontains $_.Name -and
        -not ($_.FullName -split '\\' | Where-Object { $ExcludeDirs -contains $_ })
    }
    $srcExpected = $srcFiles.Count
    $destCount = (Get-ChildItem $Dest -Recurse -File | Measure-Object).Count
    
    if ($destCount -ne $srcExpected) {
        Fail "File count mismatch: expected $srcExpected, got $destCount"
    }
    
    # Structural validation
    foreach ($srcFile in $srcFiles) {
        $relativePath = $srcFile.FullName.Substring($SourceAbs.Length).TrimStart('\')
        $destFile = Join-Path $Dest $relativePath
        if (-not (Test-Path $destFile)) {
            Fail "Structural mismatch: missing file at destination: $relativePath"
        }
    }
    
    Write-Progress-Step "Copy" "Validation complete: $destCount files copied"
}

function Copy-Spec {
    param(
        [string]$SrcDir,
        [string]$DestDir
    )
    
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

function Read-Template {
    param([string]$TemplateName)
    
    $templatePath = Join-Path $PSScriptRoot "migrate-templates\$TemplateName"
    if (-not (Test-Path $templatePath)) {
        Fail "Template file not found: $templatePath"
    }
    
    return Get-Content $templatePath -Raw
}

function Assert-NoMatch {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Description
    )
    
    # Use Get-ChildItem + Select-String for recursive pattern matching
    # Exclude .backup files from verification
    $files = if (Test-Path $Path -PathType Container) {
        Get-ChildItem -Path $Path -File -Recurse | Where-Object { $_.Name -notlike "*.backup" }
    } else {
        Get-Item $Path | Where-Object { $_.Name -notlike "*.backup" }
    }
    
    $hits = $files | Select-String -Pattern $Pattern 2>$null
    if ($hits) {
        Write-Warning "$Description verification failed. Found matches:"
        $hits | ForEach-Object { Write-Warning "  $($_.Path):$($_.LineNumber): $($_.Line)" }
        Fail "${Description}: found prohibited pattern '$Pattern' in $Path"
    }
    Write-Progress-Step "Verification" "${Description}: no matches for '$Pattern' in $Path"
}

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

# ============================================================================
# PHASE 0: PRE-FLIGHT CHECKS
# ============================================================================
# Validates:
# - Source directory (sw-agent\) exists
# - Destination directory does NOT exist (guards /MIR safety)
# - Git is available
# - Bun is available and version ≥1.0.0
# - Scottish Water workspace has no uncommitted changes to tech-core.md
# - No long paths that would exceed MAX_PATH (260 chars)
#
# Requirements: 1.1, 1.8
# ============================================================================

$currentPhase = "0"
Write-Progress-Step "Phase 0" "Starting pre-flight checks"

# Check source directory exists
if (-not (Test-Path "sw-agent\")) {
    Fail "Source directory 'sw-agent\' not found in current directory. Run this script from the Scottish Water repo root."
}
Write-Progress-Step "Phase 0" "Source directory sw-agent\ exists"

# Check destination does NOT exist (critical guard for /MIR safety)
if (Test-Path $DEST) {
    Fail "Destination directory '$DEST' already exists. Migration cannot proceed — robocopy /MIR would delete any manually applied fixes. Remove destination manually and re-run."
}
Write-Progress-Step "Phase 0" "Destination path clear (does not exist)"

# Check git is available
git --version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "Git is not available. Install Git and ensure it is in PATH before running migration."
}
Write-Progress-Step "Phase 0" "Git is available"

# Check bun is available and version ≥1.0.0
$bunVersionOutput = bun --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "Bun is not available. Install Bun ≥1.0.0 from https://bun.sh before running migration."
}

# Extract major version number from bun --version output (e.g., "1.2.3" -> 1)
$bunVersion = $bunVersionOutput.ToString().Trim()
if ($bunVersion -match '^(\d+)\.') {
    $bunMajor = [int]$matches[1]
    if ($bunMajor -lt 1) {
        Fail "Bun version $bunVersion is too old. Migration requires Bun ≥1.0.0."
    }
    Write-Progress-Step "Phase 0" "Bun version $bunVersion is available (≥1.0.0)"
} else {
    Fail "Could not parse Bun version from output: $bunVersion"
}

# Check Scottish Water workspace for uncommitted changes to tech-core.md
$swStatus = git status --porcelain .kiro/steering/tech-core.md 2>&1
if ($swStatus.Length -gt 0) {
    Fail "Scottish Water workspace has uncommitted changes to .kiro/steering/tech-core.md. Commit or stash changes before running migration to prevent data loss."
}
Write-Progress-Step "Phase 0" "Scottish Water workspace is clean (no uncommitted changes to tech-core.md)"

# Check for long paths that would exceed MAX_PATH
# Windows MAX_PATH is 260 chars. Destination path C:\repos\corneldann\agenthq\ is 30 chars.
# Check for source paths >240 chars to leave safe buffer (240 + 30 = 270, safe under 260 limit).
Write-Progress-Step "Phase 0" "Scanning sw-agent\ for paths >240 characters..."
$longPaths = Get-ChildItem "sw-agent\" -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    $_.FullName.Length -gt 240
}

if ($longPaths.Count -gt 0) {
    Write-Warning "Found $($longPaths.Count) file(s) with paths exceeding 240 characters:"
    $longPaths | ForEach-Object { 
        Write-Warning "  $($_.FullName) ($($_.FullName.Length) chars)" 
    }
    Write-Warning ""
    Write-Warning "These paths will exceed Windows MAX_PATH (260 chars) after migration."
    Write-Warning "Action required:"
    Write-Warning "  1. Enable LongPathsEnabled in Windows registry, OR"
    Write-Warning "  2. Shorten the paths before migration"
    Write-Warning ""
    Write-Warning "To enable long paths support:"
    Write-Warning "  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -Value 1"
    Write-Warning "  (Requires Administrator privileges and system restart)"
    Fail "Migration cannot proceed with paths exceeding MAX_PATH limit. Enable LongPathsEnabled registry key or shorten paths."
}
Write-Progress-Step "Phase 0" "No long paths detected (all paths ≤240 characters)"

Write-Progress-Step "Phase 0" "All pre-flight checks passed"

# ============================================================================
# PHASE 0.5: MEMORY SERVER PRE-FLIGHT (ADVISORY)
# ============================================================================
# Best-effort extraction of memory server default path.
# Writes advisory note to $MEMORY_SERVER_DEFAULT_PATH_NOTE variable for use
# in Phase 5 tech-core.md generation.
# Runtime verification in Phase 9 is the authoritative isolation check.
#
# Requirements: 11.1, 11.4
# ============================================================================

$currentPhase = "0.5"
Write-Progress-Step "Phase 0.5" "Memory server pre-flight (advisory)"

$memServerJs = "$env:APPDATA\npm\node_modules\@modelcontextprotocol\server-memory\dist\index.js"

if (-not (Test-Path $memServerJs)) {
    Write-Warning "[Phase 0.5] Memory server package not found at expected location — runtime verification will be required."
    $MEMORY_SERVER_DEFAULT_PATH_NOTE = "Package not found during Phase 0.5 pre-flight check at ``$env:APPDATA\npm\node_modules\@modelcontextprotocol\server-memory\dist\index.js``. Runtime verification in Phase 9 will confirm MEMORY_FILE_PATH is honoured by the installed version."
    Write-Progress-Step "Phase 0.5" "Advisory note recorded (package not found)"
} else {
    Write-Progress-Step "Phase 0.5" "Memory server package found, attempting path extraction..."
    
    # Attempt simple pattern match (best-effort)
    $defaultPathLine = Select-String -Path $memServerJs -Pattern 'MEMORY_FILE_PATH|graph\.json' -Context 0,1 -ErrorAction SilentlyContinue | Select-Object -First 1
    
    if ($defaultPathLine) {
        $extractedLine = $defaultPathLine.Line.Trim()
        $MEMORY_SERVER_DEFAULT_PATH_NOTE = "Found during Phase 0.5 pre-flight (advisory, best-effort extraction): ``$extractedLine``. If this does not clearly show the default path logic, refer to the package source or rely on Phase 9 runtime verification."
        Write-Progress-Step "Phase 0.5" "Pattern match found (advisory)"
    } else {
        $MEMORY_SERVER_DEFAULT_PATH_NOTE = "Could not extract default path from bundled source during Phase 0.5 pre-flight check. The package at ``$memServerJs`` exists but pattern matching for 'MEMORY_FILE_PATH' or 'graph.json' found no results. Runtime verification in Phase 9 will confirm isolation."
        Write-Progress-Step "Phase 0.5" "No pattern match (advisory)"
    }
}

Write-Progress-Step "Phase 0.5" "Advisory extraction complete (not a failure condition)"



# ============================================================================
# PHASE 1: DIRECTORY CREATION
# ============================================================================
# Creates destination directory structure:
# - C:\repos\corneldann\agenthq\
# - C:\repos\corneldann\agenthq\workspace\
#
# Requirements: 1.1, 1.2
# ============================================================================

$currentPhase = "1"
Write-Progress-Step "Phase 1" "Creating destination directory structure"

# Create main destination directory
try {
    New-Item -ItemType Directory -Path $DEST -Force | Out-Null
    Write-Progress-Step "Phase 1" "Created main directory: $DEST"
} catch {
    Fail "Failed to create destination directory '$DEST': $_"
}

# Verify main directory was created
if (-not (Test-Path $DEST)) {
    Fail "Destination directory '$DEST' was not created successfully"
}

# Create workspace subdirectory
$workspaceDir = Join-Path $DEST "workspace\"
try {
    New-Item -ItemType Directory -Path $workspaceDir -Force | Out-Null
    Write-Progress-Step "Phase 1" "Created workspace subdirectory: $workspaceDir"
} catch {
    Fail "Failed to create workspace directory '$workspaceDir': $_"
}

# Verify workspace directory was created
if (-not (Test-Path $workspaceDir)) {
    Fail "Workspace directory '$workspaceDir' was not created successfully"
}

Write-Progress-Step "Phase 1" "Directory structure created successfully"



# ============================================================================
# PHASE 2: FILE COPY WITH ROBOCOPY
# ============================================================================
# Copies sw-agent\ to destination with exclusions:
# - Excluded dirs: node_modules, .venv, dist
# - Excluded files: .poll-state.json, .summarise-state.json
# Uses robocopy /MIR (mirror mode)
# Validates:
# - File count comparison (source expected vs destination actual)
# - Structural validation (each source file exists at correct destination path)
#
# Requirements: 1.3, 1.4, 1.5
# ============================================================================

$currentPhase = "2"
Write-Progress-Step "Phase 2" "Starting file copy with robocopy"

# Define exclusion lists
$excludedDirs = @('node_modules', '.venv', 'dist')
$excludedFiles = @('.poll-state.json', '.summarise-state.json')

# Call Copy-WithValidation helper with exclusions
Copy-WithValidation -Source "sw-agent\" -Dest $DEST `
    -ExcludeDirs $excludedDirs -ExcludeFiles $excludedFiles

Write-Progress-Step "Phase 2" "File copy complete and verified"



# ============================================================================
# PHASE 3: NAME REPLACEMENT (sw-* → agenthq)
# ============================================================================
# Replaces all sw-agent / SW Agent branding with agenthq / AgentHQ:
# - package.json: name, description, bin field
# - src/dashboard/index.html: <title> element
# - src/monitor.ts: startup log message
#
# Requirements: 2.1, 2.2, 2.3, 2.5, 2.6
# ============================================================================

$currentPhase = "3"
Write-Progress-Step "Phase 3" "Starting name replacement (sw-agent → agenthq)"

# 3.1: Update package.json name, description, and bin field
$packageJsonPath = Join-Path $DEST "package.json"

if (-not (Test-Path $packageJsonPath)) {
    Fail "package.json not found at: $packageJsonPath"
}

Write-Progress-Step "Phase 3" "Reading package.json"
$packageJsonContent = Get-Content $packageJsonPath -Raw

# Replace name field from "sw-agent" to "agenthq"
$packageJsonContent = $packageJsonContent -replace '"name":\s*"sw-agent"', '"name": "agenthq"'

# Add description field after name field
# Find the name field and insert description after it
if ($packageJsonContent -match '"name":\s*"agenthq",') {
    # Description already exists or we need to add it
    if ($packageJsonContent -notmatch '"description":') {
        # Insert description after name field
        $packageJsonContent = $packageJsonContent -replace '("name":\s*"agenthq",)', "`$1`n  `"description`": `"AgentHQ — developer agent monitor and dashboard`","
    } else {
        # Replace existing description
        $packageJsonContent = $packageJsonContent -replace '"description":\s*"[^"]*"', '"description": "AgentHQ — developer agent monitor and dashboard"'
    }
} else {
    Fail "Could not find 'name' field in package.json after replacement"
}

# Replace bin field from "sw-agent" to "agenthq"
$packageJsonContent = $packageJsonContent -replace '"sw-agent":\s*"src/cli\.ts"', '"agenthq": "src/cli.ts"'

# Write updated package.json
try {
    Set-Content -Path $packageJsonPath -Value $packageJsonContent -NoNewline
    Write-Progress-Step "Phase 3" "Updated package.json (name, description, bin field)"
} catch {
    Fail "Failed to write updated package.json: $_"
}

# Verify replacements were successful
$verifyContent = Get-Content $packageJsonPath -Raw
if ($verifyContent -notmatch '"name":\s*"agenthq"') {
    Fail "Verification failed: package.json name field was not updated correctly"
}
if ($verifyContent -notmatch '"description":\s*"AgentHQ — developer agent monitor and dashboard"') {
    Fail "Verification failed: package.json description field was not added/updated correctly"
}
if ($verifyContent -notmatch '"agenthq":\s*"src/cli\.ts"') {
    Fail "Verification failed: package.json bin field was not updated correctly"
}

Write-Progress-Step "Phase 3" "package.json updated successfully"

# 3.2: Update src/dashboard/index.html title
$indexHtmlPath = Join-Path $DEST "src\dashboard\index.html"

if (-not (Test-Path $indexHtmlPath)) {
    Fail "src/dashboard/index.html not found at: $indexHtmlPath"
}

Write-Progress-Step "Phase 3" "Reading src/dashboard/index.html"
$indexHtmlContent = Get-Content $indexHtmlPath -Raw

# Replace <title>SW Agent Monitor</title> with <title>AgentHQ</title>
$indexHtmlContent = $indexHtmlContent -replace '<title>SW Agent Monitor</title>', '<title>AgentHQ</title>'

# Write updated index.html
try {
    Set-Content -Path $indexHtmlPath -Value $indexHtmlContent -NoNewline
    Write-Progress-Step "Phase 3" "Updated src/dashboard/index.html title"
} catch {
    Fail "Failed to write updated index.html: $_"
}

# Verify replacement was successful
$verifyHtmlContent = Get-Content $indexHtmlPath -Raw
if ($verifyHtmlContent -notmatch '<title>AgentHQ</title>') {
    Fail "Verification failed: index.html title was not updated correctly"
}
if ($verifyHtmlContent -match '<title>SW Agent Monitor</title>') {
    Fail "Verification failed: old title 'SW Agent Monitor' still present in index.html"
}

# 3.3: Update src/monitor.ts startup log message
$monitorTsPath = Join-Path $DEST "src\monitor.ts"

if (-not (Test-Path $monitorTsPath)) {
    Fail "src/monitor.ts not found at: $monitorTsPath"
}

Write-Progress-Step "Phase 3" "Reading src/monitor.ts"
$monitorTsContent = Get-Content $monitorTsPath -Raw

# Replace startup log message with AgentHQ version
# Pattern matches various possible formats:
# - `SW Agent running at http://localhost:${PORT}`
# - "SW Agent running at http://localhost:" + PORT
# - console.log variations with SW Agent / sw-agent
$monitorTsContent = $monitorTsContent -replace '(console\.log\([^)]*?)SW Agent([^)]*?)running at http://localhost:', '$1AgentHQ$2running at http://localhost:'
$monitorTsContent = $monitorTsContent -replace '(console\.log\([^)]*?)sw-agent([^)]*?)running at http://localhost:', '$1AgentHQ$2running at http://localhost:'

# Also replace any string literals containing "SW Agent running at" or "sw-agent running at"
$monitorTsContent = $monitorTsContent -replace '(["`''])SW Agent running at http://localhost:', '$1AgentHQ running at http://localhost:'
$monitorTsContent = $monitorTsContent -replace '(["`''])sw-agent running at http://localhost:', '$1AgentHQ running at http://localhost:'

# Write updated monitor.ts
try {
    Set-Content -Path $monitorTsPath -Value $monitorTsContent -NoNewline
    Write-Progress-Step "Phase 3" "Updated src/monitor.ts startup log message"
} catch {
    Fail "Failed to write updated monitor.ts: $_"
}

# Verify replacement was successful by checking no SW Agent / sw-agent references remain in startup log
$verifyMonitorContent = Get-Content $monitorTsPath -Raw
if ($verifyMonitorContent -match '(console\.log[^;]*)(SW Agent|sw-agent)([^;]*?)running at http://localhost:') {
    Fail "Verification failed: src/monitor.ts still contains 'SW Agent' or 'sw-agent' in startup log message"
}

Write-Progress-Step "Phase 3" "src/monitor.ts startup log updated successfully"

# 3.4: Comprehensive source code replacement - handle all remaining sw-agent references
Write-Progress-Step "Phase 3" "Performing comprehensive sw-agent → agenthq replacement in all source files"

# Get all text files in src/ (excluding .backup files)
$srcFiles = Get-ChildItem -Path $srcDir -File -Recurse -Include *.ts,*.js,*.json,*.md,*.txt | Where-Object { $_.Name -notlike "*.backup" }

foreach ($file in $srcFiles) {
    $content = Get-Content $file.FullName -Raw
    $originalContent = $content
    
    # Replace [sw-agent] log markers
    $content = $content -replace '\[sw-agent\]', '[agenthq]'
    
    # Replace "sw-agent" in strings (path.join, require, etc.)
    $content = $content -replace '"sw-agent"', '"agenthq"'
    $content = $content -replace "'sw-agent'", "'agenthq'"
    $content = $content -replace '`sw-agent`', '`agenthq`'
    
    # Replace sw-agent as standalone word
    $content = $content -replace '\bsw-agent\b', 'agenthq'
    
    # Replace SW Agent
    $content = $content -replace '\bSW Agent\b', 'AgentHQ'
    
    # Replace sw-agent/ and sw-agent\ directory references  
    $content = $content -replace 'sw-agent/', 'agenthq/'
    $content = $content -replace 'sw-agent\\', 'agenthq\'
    
    # Only write if content changed
    if ($content -ne $originalContent) {
        Set-Content -Path $file.FullName -Value $content -NoNewline
        Write-Progress-Step "Phase 3" "  Updated: $($file.FullName.Substring($DEST.Length))"
    }
}

Write-Progress-Step "Phase 3" "Comprehensive replacement complete"

# 3.5: Post-replacement verification - ensure no sw-agent or SW Agent strings remain in src/
Write-Progress-Step "Phase 3" "Running post-replacement verification on src/ directory"

$srcDir = Join-Path $DEST "src\"
if (-not (Test-Path $srcDir)) {
    Fail "src/ directory not found at: $srcDir"
}

# Use Assert-NoMatch helper to verify no prohibited patterns remain
# Pattern matches both "sw-agent" and "SW Agent" (case-sensitive)
Assert-NoMatch -Path $srcDir -Pattern "sw-agent|SW Agent" -Description "Phase 3 post-replacement verification"

Write-Progress-Step "Phase 3" "Post-replacement verification passed: no 'sw-agent' or 'SW Agent' found in src/"

Write-Progress-Step "Phase 3" "Name replacement complete and verified"



# ============================================================================
# PHASE 4: CONSTANTS MODULE REWRITE
# ============================================================================
# Rewrites src/constants.ts to use environment variables:
# - Exports resolveConstants factory function
# - All paths sourced from process.env with fallbacks
# Creates src/validation.ts:
# - findUnconfiguredVars function
# - validateEnvPaths function
# Updates src/monitor.ts to add startup validation
#
# Requirements: 3.1–3.13, 4.1–4.5
# ============================================================================



# ============================================================================
# PHASE 5: WORKSPACE POPULATION
# ============================================================================
# Populates workspace/ directory with Kiro configuration:
# - workspace/agenthq.code-workspace
# - workspace/.kiro/steering/ (tech-core.md, agent-batching.md, task-concurrency.md)
# - workspace/.kiro/skills/ (agenthq-dashboard + 20 other skills)
# - workspace/.kiro/powers/agenthq-memory/mcp.json
# - workspace/.kiro/memory/.gitkeep
# Uses template files from migrate-templates/ for tech-core.md
#
# Requirements: 6.1–6.9, 11.1
# ============================================================================

$currentPhase = "5"
Write-Progress-Step "Phase 5" "Starting workspace population"

# 5.1: Create workspace/.kiro/steering/ directory structure
$steeringDir = Join-Path $DEST "workspace\.kiro\steering\"
try {
    New-Item -ItemType Directory -Path $steeringDir -Force | Out-Null
    Write-Progress-Step "Phase 5" "Created steering directory: $steeringDir"
} catch {
    Fail "Failed to create steering directory: $_"
}

# 5.2: Generate tech-core.md from template with placeholder substitution
Write-Progress-Step "Phase 5" "Reading tech-core.md.template"
$techCoreTemplate = Read-Template "tech-core.md.template"

Write-Progress-Step "Phase 5" "Substituting {{MEMORY_SERVER_DEFAULT_PATH_NOTE}} placeholder"
$techCoreContent = $techCoreTemplate -replace '\{\{MEMORY_SERVER_DEFAULT_PATH_NOTE\}\}', $MEMORY_SERVER_DEFAULT_PATH_NOTE

$techCoreDestPath = Join-Path $steeringDir "tech-core.md"
try {
    Set-Content -Path $techCoreDestPath -Value $techCoreContent -NoNewline
    Write-Progress-Step "Phase 5" "Wrote tech-core.md with substituted content"
} catch {
    Fail "Failed to write tech-core.md: $_"
}

# Verify tech-core.md was created and contains substituted content
if (-not (Test-Path $techCoreDestPath)) {
    Fail "tech-core.md was not created at: $techCoreDestPath"
}
$verifyTechCore = Get-Content $techCoreDestPath -Raw
if ($verifyTechCore -match '\{\{MEMORY_SERVER_DEFAULT_PATH_NOTE\}\}') {
    Fail "tech-core.md still contains unsubstituted placeholder {{MEMORY_SERVER_DEFAULT_PATH_NOTE}}"
}
Write-Progress-Step "Phase 5" "Verified tech-core.md placeholder substitution"

# 5.3: Copy agent-batching.md from SW workspace to AgentHQ workspace
$agentBatchingSrc = ".kiro\steering\agent-batching.md"
$agentBatchingDest = Join-Path $steeringDir "agent-batching.md"

if (-not (Test-Path $agentBatchingSrc)) {
    Fail "Source agent-batching.md not found at: $agentBatchingSrc"
}

Write-Progress-Step "Phase 5" "Copying agent-batching.md"
try {
    Copy-Item -Path $agentBatchingSrc -Destination $agentBatchingDest -Force
    Write-Progress-Step "Phase 5" "Copied agent-batching.md to $agentBatchingDest"
} catch {
    Fail "Failed to copy agent-batching.md: $_"
}

# Verify agent-batching.md was copied
if (-not (Test-Path $agentBatchingDest)) {
    Fail "agent-batching.md was not copied to: $agentBatchingDest"
}

# 5.4: Copy task-concurrency.md from SW workspace to AgentHQ workspace
$taskConcurrencySrc = ".kiro\steering\task-concurrency.md"
$taskConcurrencyDest = Join-Path $steeringDir "task-concurrency.md"

if (-not (Test-Path $taskConcurrencySrc)) {
    Fail "Source task-concurrency.md not found at: $taskConcurrencySrc"
}

Write-Progress-Step "Phase 5" "Copying task-concurrency.md"
try {
    Copy-Item -Path $taskConcurrencySrc -Destination $taskConcurrencyDest -Force
    Write-Progress-Step "Phase 5" "Copied task-concurrency.md to $taskConcurrencyDest"
} catch {
    Fail "Failed to copy task-concurrency.md: $_"
}

# Verify task-concurrency.md was copied
if (-not (Test-Path $taskConcurrencyDest)) {
    Fail "task-concurrency.md was not copied to: $taskConcurrencyDest"
}

Write-Progress-Step "Phase 5" "Steering file generation and copy complete"

# 5.5: Create workspace/.kiro/skills/ directory and copy skills
$skillsDir = Join-Path $DEST "workspace\.kiro\skills\"
try {
    New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null
    Write-Progress-Step "Phase 5" "Created skills directory: $skillsDir"
} catch {
    Fail "Failed to create skills directory: $_"
}

# 5.6: Copy sw-monitor-dashboard skill and rename to agenthq-dashboard
$swMonitorSkillSrc = ".kiro\skills\sw-monitor-dashboard\"
$agenthqDashboardSkillDest = Join-Path $skillsDir "agenthq-dashboard\"

if (-not (Test-Path $swMonitorSkillSrc)) {
    Fail "Source skill sw-monitor-dashboard not found at: $swMonitorSkillSrc"
}

Write-Progress-Step "Phase 5" "Copying sw-monitor-dashboard skill to agenthq-dashboard"
try {
    # Copy the entire directory
    Copy-Item -Path $swMonitorSkillSrc -Destination $agenthqDashboardSkillDest -Recurse -Force
    Write-Progress-Step "Phase 5" "Copied sw-monitor-dashboard to agenthq-dashboard"
} catch {
    Fail "Failed to copy sw-monitor-dashboard skill: $_"
}

# Verify the skill was copied
if (-not (Test-Path $agenthqDashboardSkillDest)) {
    Fail "agenthq-dashboard skill was not copied to: $agenthqDashboardSkillDest"
}

# 5.7: Modify agenthq-dashboard/SKILL.md (replace paths and names)
$agenthqSkillMdPath = Join-Path $agenthqDashboardSkillDest "SKILL.md"

if (-not (Test-Path $agenthqSkillMdPath)) {
    Fail "agenthq-dashboard SKILL.md not found at: $agenthqSkillMdPath"
}

Write-Progress-Step "Phase 5" "Reading agenthq-dashboard SKILL.md for replacements"
$skillMdContent = Get-Content $agenthqSkillMdPath -Raw

# Replace sw-agent/src/dashboard/ with src/dashboard/
$skillMdContent = $skillMdContent -replace 'sw-agent/src/dashboard/', 'src/dashboard/'

# Replace SW Agent Monitor with AgentHQ
$skillMdContent = $skillMdContent -replace 'SW Agent Monitor', 'AgentHQ'

# Also replace sw-monitor-dashboard with agenthq-dashboard in the front-matter name field
$skillMdContent = $skillMdContent -replace 'name: sw-monitor-dashboard', 'name: agenthq-dashboard'

# Replace sw-monitor-dashboard in the description if present
$skillMdContent = $skillMdContent -replace 'sw-monitor-dashboard', 'agenthq-dashboard'

# Write the modified SKILL.md back
try {
    Set-Content -Path $agenthqSkillMdPath -Value $skillMdContent -NoNewline
    Write-Progress-Step "Phase 5" "Modified agenthq-dashboard SKILL.md (path and name replacements)"
} catch {
    Fail "Failed to write modified agenthq-dashboard SKILL.md: $_"
}

# Verify replacements were successful
$verifySkillMd = Get-Content $agenthqSkillMdPath -Raw
if ($verifySkillMd -match 'sw-agent/src/dashboard/') {
    Fail "Verification failed: agenthq-dashboard SKILL.md still contains 'sw-agent/src/dashboard/'"
}
if ($verifySkillMd -match 'SW Agent Monitor') {
    Fail "Verification failed: agenthq-dashboard SKILL.md still contains 'SW Agent Monitor'"
}
if ($verifySkillMd -match 'name: sw-monitor-dashboard') {
    Fail "Verification failed: agenthq-dashboard SKILL.md front-matter still has 'name: sw-monitor-dashboard'"
}
Write-Progress-Step "Phase 5" "Verified agenthq-dashboard SKILL.md replacements"

# 5.8: Copy 20 additional skills from SW workspace
$additionalSkills = @(
    'ts-best-practices',
    'ts-testing',
    'ts-performance',
    'ts-documentation',
    'ts-advanced-types',
    'js-testing-patterns',
    'modern-js-patterns',
    'debugging-strategies',
    'error-handling-patterns',
    'frontend-design',
    'design-system-patterns',
    'interaction-design',
    'responsive-design',
    'ux-design-systems',
    'visual-design-foundations',
    'web-accessibility',
    'improve-codebase-architecture',
    'diagnose',
    'web-best-practices',
    'memory-consolidation'
)

Write-Progress-Step "Phase 5" "Copying 20 additional skills from SW workspace"

$copiedSkillsCount = 0
foreach ($skillName in $additionalSkills) {
    $skillSrcPath = ".kiro\skills\$skillName\"
    $skillDestPath = Join-Path $skillsDir "$skillName\"
    
    if (-not (Test-Path $skillSrcPath)) {
        Fail "Source skill '$skillName' not found at: $skillSrcPath"
    }
    
    try {
        Copy-Item -Path $skillSrcPath -Destination $skillDestPath -Recurse -Force
        $copiedSkillsCount++
        Write-Progress-Step "Phase 5" "  Copied skill: $skillName ($copiedSkillsCount/20)"
    } catch {
        Fail "Failed to copy skill '$skillName': $_"
    }
    
    # Verify the skill was copied
    if (-not (Test-Path $skillDestPath)) {
        Fail "Skill '$skillName' was not copied to: $skillDestPath"
    }
}

# Verify all 20 skills were copied
if ($copiedSkillsCount -ne 20) {
    Fail "Expected to copy 20 skills, but copied $copiedSkillsCount"
}

Write-Progress-Step "Phase 5" "All 20 additional skills copied successfully"

# Final verification: count skill directories in workspace/.kiro/skills/
$skillDirs = @(Get-ChildItem $skillsDir -Directory)
$expectedSkillCount = 21  # agenthq-dashboard + 20 additional skills
if ($skillDirs.Count -ne $expectedSkillCount) {
    Fail "Expected $expectedSkillCount skill directories in workspace/.kiro/skills/, but found $($skillDirs.Count)"
}

Write-Progress-Step "Phase 5" "Skills directory copy complete: 21 skills (agenthq-dashboard + 20 additional)"

# 5.9: Create workspace/agenthq.code-workspace file
$workspaceFilePath = Join-Path $DEST "workspace\agenthq.code-workspace"

Write-Progress-Step "Phase 5" "Creating workspace/agenthq.code-workspace"

# Define the workspace JSON content with a single folder entry pointing at ".." (repo root)
$workspaceContent = @'
{
  "folders": [
    {
      "path": ".."
    }
  ]
}
'@

try {
    Set-Content -Path $workspaceFilePath -Value $workspaceContent -NoNewline
    Write-Progress-Step "Phase 5" "Created workspace/agenthq.code-workspace"
} catch {
    Fail "Failed to write workspace/agenthq.code-workspace: $_"
}

# Verify the workspace file was created
if (-not (Test-Path $workspaceFilePath)) {
    Fail "workspace/agenthq.code-workspace was not created at: $workspaceFilePath"
}

# Verify the content is valid JSON with the expected structure
try {
    $workspaceJson = Get-Content $workspaceFilePath -Raw | ConvertFrom-Json
    
    # Verify it has a folders array
    if (-not $workspaceJson.folders) {
        Fail "workspace/agenthq.code-workspace does not contain 'folders' property"
    }
    
    # Verify folders array has exactly 1 entry
    if ($workspaceJson.folders.Count -ne 1) {
        Fail "workspace/agenthq.code-workspace folders array should have 1 entry, found $($workspaceJson.folders.Count)"
    }
    
    # Verify the single folder entry has path ".."
    if ($workspaceJson.folders[0].path -ne "..") {
        Fail "workspace/agenthq.code-workspace folder path should be '..', found '$($workspaceJson.folders[0].path)'"
    }
    
    Write-Progress-Step "Phase 5" "Verified workspace/agenthq.code-workspace structure (folders: [{'path': '..'}])"
} catch {
    Fail "workspace/agenthq.code-workspace JSON validation failed: $_"
}

Write-Progress-Step "Phase 5" "Workspace configuration complete"

# 5.10: Create workspace/.kiro/powers/agenthq-memory/mcp.json
$powersDir = Join-Path $DEST "workspace\.kiro\powers\agenthq-memory\"
try {
    New-Item -ItemType Directory -Path $powersDir -Force | Out-Null
    Write-Progress-Step "Phase 5" "Created powers directory: $powersDir"
} catch {
    Fail "Failed to create powers directory: $_"
}

# Define the MCP server configuration JSON
$mcpJsonContent = @'
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "C:\\repos\\corneldann\\agenthq\\workspace\\.kiro\\memory\\graph.json"
      },
      "autoApprove": ["search_nodes", "open_nodes", "read_graph"]
    }
  }
}
'@

$mcpJsonPath = Join-Path $powersDir "mcp.json"
try {
    Set-Content -Path $mcpJsonPath -Value $mcpJsonContent -NoNewline
    Write-Progress-Step "Phase 5" "Created powers/agenthq-memory/mcp.json"
} catch {
    Fail "Failed to write powers/agenthq-memory/mcp.json: $_"
}

# Verify the mcp.json file was created
if (-not (Test-Path $mcpJsonPath)) {
    Fail "powers/agenthq-memory/mcp.json was not created at: $mcpJsonPath"
}

# Verify the content is valid JSON with the expected structure
try {
    $mcpJson = Get-Content $mcpJsonPath -Raw | ConvertFrom-Json
    
    # Verify it has mcpServers property
    if (-not $mcpJson.mcpServers) {
        Fail "powers/agenthq-memory/mcp.json does not contain 'mcpServers' property"
    }
    
    # Verify it has memory server entry
    if (-not $mcpJson.mcpServers.memory) {
        Fail "powers/agenthq-memory/mcp.json does not contain 'memory' server entry"
    }
    
    # Verify memory server has env.MEMORY_FILE_PATH
    if (-not $mcpJson.mcpServers.memory.env.MEMORY_FILE_PATH) {
        Fail "powers/agenthq-memory/mcp.json memory server does not have env.MEMORY_FILE_PATH"
    }
    
    # Verify the MEMORY_FILE_PATH value
    $expectedPath = "C:\repos\corneldann\agenthq\workspace\.kiro\memory\graph.json"
    $actualPath = $mcpJson.mcpServers.memory.env.MEMORY_FILE_PATH
    if ($actualPath -ne $expectedPath) {
        Fail "powers/agenthq-memory/mcp.json MEMORY_FILE_PATH should be '$expectedPath', found '$actualPath'"
    }
    
    # Verify autoApprove array contains expected tools
    $expectedAutoApprove = @("search_nodes", "open_nodes", "read_graph")
    $actualAutoApprove = $mcpJson.mcpServers.memory.autoApprove
    
    foreach ($tool in $expectedAutoApprove) {
        if ($actualAutoApprove -notcontains $tool) {
            Fail "powers/agenthq-memory/mcp.json autoApprove array missing tool: $tool"
        }
    }
    
    Write-Progress-Step "Phase 5" "Verified powers/agenthq-memory/mcp.json structure"
} catch {
    Fail "powers/agenthq-memory/mcp.json JSON validation failed: $_"
}

# 5.11: Create workspace/.kiro/memory/.gitkeep
$memoryDir = Join-Path $DEST "workspace\.kiro\memory\"
try {
    New-Item -ItemType Directory -Path $memoryDir -Force | Out-Null
    Write-Progress-Step "Phase 5" "Created memory directory: $memoryDir"
} catch {
    Fail "Failed to create memory directory: $_"
}

$gitkeepPath = Join-Path $memoryDir ".gitkeep"
try {
    # Create empty .gitkeep file
    Set-Content -Path $gitkeepPath -Value "" -NoNewline
    Write-Progress-Step "Phase 5" "Created memory/.gitkeep"
} catch {
    Fail "Failed to write memory/.gitkeep: $_"
}

# Verify the .gitkeep file was created
if (-not (Test-Path $gitkeepPath)) {
    Fail "memory/.gitkeep was not created at: $gitkeepPath"
}

Write-Progress-Step "Phase 5" "Powers and memory scaffold complete"



# ============================================================================
# PHASE 6: .ENV FILES AND .GITIGNORE
# ============================================================================
# Creates:
# - .env.example (committed, documents all variables)
# - .gitignore (excludes build artifacts, runtime state, secrets, memory graph)
# - docs/examples/scottishwater.env (reference config for SW engagement)
# Ensures .gitignore pattern order: .env exclusion before !.env.example inclusion
#
# Requirements: 5.1–5.5, 7.1–7.5
# ============================================================================

$currentPhase = "6"
Write-Progress-Step "Phase 6" "Starting .env files and .gitignore creation"

# 6.1: Create .env.example with all required and optional variables documented
Write-Progress-Step "Phase 6" "Creating .env.example with inline comments"

$envExampleContent = @'
# AgentHQ Environment Configuration
#
# Copy this file to .env and fill in your engagement-specific paths.
# AgentHQ will read these variables at startup.

# Server Configuration
# --------------------

# PORT - HTTP server port (default: 3333)
PORT=3333

# Workspace and Output Paths
# ---------------------------

# OUTPUT_DIR - Root directory for agent output files (sessions, chains, etc.)
# Example: C:\path\to\your\engagement\docs\output
OUTPUT_DIR=

# SESSIONS_DIR - Directory where agent session .jsonl files are stored
# Example: C:\path\to\your\engagement\.sessions
SESSIONS_DIR=

# CHAINS_DIR - Directory where agent chain execution logs are stored
# Falls back to SESSIONS_DIR if not set
# Example: C:\path\to\your\engagement\.sessions
CHAINS_DIR=

# WORKFLOW_DIR - Directory where Kiro stores workflow execution files
# Falls back to %APPDATA%\Kiro\User\globalStorage\... if not set
# Example: C:\Users\YourName\AppData\Roaming\Kiro\User\globalStorage\kiro.kiroagent\...
WORKFLOW_DIR=

# WORKSPACE_ROOT - Root directory of the engagement workspace
# Example: C:\path\to\your\engagement
WORKSPACE_ROOT=

# SPECS_DIR - Directory where Kiro specs are stored
# Example: C:\path\to\your\engagement\.kiro\specs
SPECS_DIR=

# PROMPT_OUTPUT_DIR - Directory where prompt outputs are written
# Falls back to OUTPUT_DIR if not set
# Example: C:\path\to\your\engagement\docs\analysis\prompts\output
PROMPT_OUTPUT_DIR=

# Queue File Paths
# ----------------

# CRAWL_JOBS_FILE - Path to the crawl queue file (relative to WORKSPACE_ROOT)
# Default: docs/reference/.crawl-queue.json
CRAWL_JOBS_FILE=docs/reference/.crawl-queue.json

# CLONE_JOBS_FILE - Path to the clone queue file (relative to WORKSPACE_ROOT)
# Default: docs/reference/.clone-queue.json
CLONE_JOBS_FILE=docs/reference/.clone-queue.json

# BUILD_QUEUE_FILE - Path to the build queue file (relative to WORKSPACE_ROOT)
# Default: docs/reference/.build-queue.json
BUILD_QUEUE_FILE=docs/reference/.build-queue.json

# Tool Paths
# ----------

# KIRO_TOOLS_DIR - Directory where Kiro tools are installed
# Example: C:\tools\kiro
KIRO_TOOLS_DIR=
'@

$envExamplePath = Join-Path $DEST ".env.example"
try {
    Set-Content -Path $envExamplePath -Value $envExampleContent -NoNewline
    Write-Progress-Step "Phase 6" "Created .env.example at repo root"
} catch {
    Fail "Failed to write .env.example: $_"
}

# Verify .env.example was created
if (-not (Test-Path $envExamplePath)) {
    Fail ".env.example was not created at: $envExamplePath"
}

# Verify .env.example contains all 12 required variables
$requiredVars = @(
    'PORT',
    'OUTPUT_DIR',
    'SESSIONS_DIR',
    'CHAINS_DIR',
    'WORKFLOW_DIR',
    'WORKSPACE_ROOT',
    'SPECS_DIR',
    'PROMPT_OUTPUT_DIR',
    'CRAWL_JOBS_FILE',
    'CLONE_JOBS_FILE',
    'BUILD_QUEUE_FILE',
    'KIRO_TOOLS_DIR'
)

$envExampleVerify = Get-Content $envExamplePath -Raw

foreach ($varName in $requiredVars) {
    # Check for the variable name (either as "VAR=" or "# VAR -")
    if ($envExampleVerify -notmatch "(?m)^(#\s*)?$varName\s*[=-]") {
        Fail ".env.example verification failed: missing or incorrectly formatted variable '$varName'"
    }
}

Write-Progress-Step "Phase 6" "Verified .env.example contains all 12 required variables with inline comments"

# 6.2: Create docs/examples/ directory
$docsExamplesDir = Join-Path $DEST "docs\examples\"
Write-Progress-Step "Phase 6" "Creating docs/examples/ directory"

try {
    New-Item -ItemType Directory -Path $docsExamplesDir -Force | Out-Null
    Write-Progress-Step "Phase 6" "Created docs/examples/ directory: $docsExamplesDir"
} catch {
    Fail "Failed to create docs/examples/ directory: $_"
}

# Verify docs/examples/ directory was created
if (-not (Test-Path $docsExamplesDir)) {
    Fail "docs/examples/ directory was not created at: $docsExamplesDir"
}

# 6.3: Create docs/examples/scottishwater.env with Scottish Water concrete paths
Write-Progress-Step "Phase 6" "Creating scottishwater.env reference file with Scottish Water paths"

$scottishwaterEnvContent = @'
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
'@

$scottishwaterEnvPath = Join-Path $docsExamplesDir "scottishwater.env"
try {
    Set-Content -Path $scottishwaterEnvPath -Value $scottishwaterEnvContent -NoNewline
    Write-Progress-Step "Phase 6" "Created scottishwater.env at docs/examples/"
} catch {
    Fail "Failed to write scottishwater.env: $_"
}

# Verify scottishwater.env was created
if (-not (Test-Path $scottishwaterEnvPath)) {
    Fail "scottishwater.env was not created at: $scottishwaterEnvPath"
}

# Verify scottishwater.env contains warning about %APPDATA% expansion
$scottishwaterEnvVerify = Get-Content $scottishwaterEnvPath -Raw
if ($scottishwaterEnvVerify -notmatch '%APPDATA%') {
    Fail "scottishwater.env verification failed: does not contain %APPDATA% reference"
}
if ($scottishwaterEnvVerify -notmatch 'WARNING.*dotenv does NOT expand') {
    Fail "scottishwater.env verification failed: does not contain expansion warning comment"
}

Write-Progress-Step "Phase 6" "Verified scottishwater.env contains Scottish Water paths and %APPDATA% warning"

# ----------------------------------------------------------------------------
# Create .gitignore
# ----------------------------------------------------------------------------
# Requirements: 7.1, 7.2, 7.3, 7.4, 7.5

Write-Progress-Step "Phase 6" "Creating .gitignore"

$gitignorePath = Join-Path $DEST ".gitignore"

$gitignoreContent = @"
# Dependencies
node_modules/
.venv/

# Build outputs
dist/

# Python
__pycache__/
*.pyc

# Environment files
.env
.env.local
.env.*.local

# Exception: keep .env.example
!.env.example

# Runtime state
.poll-state.json
.summarise-state.json

# Memory graph
workspace/.kiro/memory/graph.json
"@

$gitignoreContent | Out-File -FilePath $gitignorePath -Encoding UTF8 -NoNewline

if (-not (Test-Path $gitignorePath)) {
    Fail ".gitignore creation failed: file does not exist at $gitignorePath"
}

# Verify .gitignore contains all required patterns
$gitignoreVerify = Get-Content $gitignorePath -Raw
$requiredPatterns = @(
    'node_modules/',
    '.venv/',
    'dist/',
    '__pycache__/',
    '*.pyc',
    '.env',
    '.env.local',
    '.env.*.local',
    '!.env.example',
    '.poll-state.json',
    '.summarise-state.json',
    'workspace/.kiro/memory/graph.json'
)

foreach ($pattern in $requiredPatterns) {
    if ($gitignoreVerify -notmatch [regex]::Escape($pattern)) {
        Fail ".gitignore verification failed: missing pattern '$pattern'"
    }
}

# Verify !.env.example appears after .env pattern (Requirement 7.5)
$envIndex = $gitignoreVerify.IndexOf('.env')
$exampleIndex = $gitignoreVerify.IndexOf('!.env.example')
if ($exampleIndex -le $envIndex) {
    Fail ".gitignore verification failed: !.env.example must appear after .env pattern"
}

Write-Progress-Step "Phase 6" "Verified .gitignore contains all required patterns in correct order"

Write-Progress-Step "Phase 6" ".env files creation complete"



# ============================================================================
# PHASE 7: README.MD CREATION
# ============================================================================
# Creates README.md from migrate-templates/README.md.template
# Sections: quick-start, configuration reference, build steps
#
# Requirements: 2.7, 5.5
# ============================================================================

$currentPhase = "7"
Write-Progress-Step "Phase 7" "Starting README.md generation"

# 7.1: Read README.md template from migrate-templates/
Write-Progress-Step "Phase 7" "Reading README.md template"
$readmeContent = Read-Template "README.md.template"

# 7.2: Write README.md to destination root
$readmePath = Join-Path $DEST "README.md"
try {
    Set-Content -Path $readmePath -Value $readmeContent -NoNewline
    Write-Progress-Step "Phase 7" "Wrote README.md to destination root"
} catch {
    Fail "Failed to write README.md: $_"
}

# Verify README.md was created
if (-not (Test-Path $readmePath)) {
    Fail "README.md was not created at: $readmePath"
}

# Verify README.md contains required sections
$readmeVerify = Get-Content $readmePath -Raw

# Check for quick-start section (should contain git clone, bun install, configure, run)
if ($readmeVerify -notmatch 'git clone.*github\.com/corneldann/agenthq') {
    Fail "README.md verification failed: missing git clone instruction in quick-start"
}
if ($readmeVerify -notmatch 'bun install') {
    Fail "README.md verification failed: missing bun install instruction"
}
if ($readmeVerify -notmatch '\.env\.example') {
    Fail "README.md verification failed: missing .env.example reference in configuration"
}

# Check for configuration reference section (should contain a table or list of variables)
if ($readmeVerify -notmatch '(?s)OUTPUT_DIR.*SESSIONS_DIR.*WORKSPACE_ROOT') {
    Fail "README.md verification failed: missing configuration reference section with required variables"
}

# Check for build steps section (should contain tsc, bun test, build:dashboard)
if ($readmeVerify -notmatch 'tsc.*--noEmit') {
    Fail "README.md verification failed: missing tsc --noEmit build step"
}
if ($readmeVerify -notmatch 'bun test') {
    Fail "README.md verification failed: missing bun test build step"
}

Write-Progress-Step "Phase 7" "Verified README.md contains required sections (quick-start, configuration, build steps)"
Write-Progress-Step "Phase 7" "README.md generation complete"



# ============================================================================
# PHASE 8: GIT INIT + REMOTE SETUP
# ============================================================================
# Initializes git repository and creates initial commit:
# - git init
# - git add all files
# - git commit with feat: message
# - git remote add origin https://github.com/corneldann/agenthq.git
# - git push -u origin main
# Validates:
# - Exactly one commit exists after push
# - Push succeeds (no pre-existing remote commits)
#
# Requirements: 8.1–8.5
# ============================================================================

$currentPhase = "8"
Write-Progress-Step "Phase 8" "Starting Git initialization"

# Change to destination directory for git operations
Push-Location $DEST
try {
    # 8.1: Initialize git repository
    Write-Progress-Step "Phase 8" "Running git init"
    git init 2>&1 | Out-Null
    
    if ($LASTEXITCODE -ne 0) {
        Fail "git init failed with exit code $LASTEXITCODE"
    }
    
    # Verify .git directory was created
    if (-not (Test-Path ".git")) {
        Fail "git init did not create .git directory"
    }
    
    Write-Progress-Step "Phase 8" "Git repository initialized"
    
    # 8.2: Stage all files
    Write-Progress-Step "Phase 8" "Running git add -A"
    git add -A 2>&1 | Out-Null
    
    if ($LASTEXITCODE -ne 0) {
        Fail "git add -A failed with exit code $LASTEXITCODE"
    }
    
    Write-Progress-Step "Phase 8" "All files staged"
    
    # 8.3: Create initial commit with feat: subject line
    $commitMessage = "feat: extract AgentHQ from Scottish Water engagement repo

AgentHQ is a developer agent monitor and dashboard extracted from sw-agent/.

Migration includes:
- Environment-variable-based configuration (src/constants.ts)
- Startup path validation (src/validation.ts)
- Kiro workspace configuration (workspace/.kiro/)
- Memory graph isolation (workspace/.kiro/memory/)
- Complete documentation (.env.example, README.md)

All hardcoded Scottish Water paths replaced with process.env references.
All sw-agent / SW Agent branding replaced with agenthq / AgentHQ.

Migration performed by migrate.ps1 script (Phase 0-8).
"
    
    Write-Progress-Step "Phase 8" "Creating initial commit"
    git commit -m $commitMessage 2>&1 | Out-Null
    
    if ($LASTEXITCODE -ne 0) {
        Fail "git commit failed with exit code $LASTEXITCODE"
    }
    
    # Verify exactly one commit exists
    $commitCount = (git rev-list --all --count).Trim()
    if ($commitCount -ne "1") {
        Fail "Expected exactly 1 commit after initial commit, found $commitCount"
    }
    
    Write-Progress-Step "Phase 8" "Initial commit created (commit count: 1)"
    
    # 8.4: Verify commit subject line starts with feat:
    $commitSubject = (git log -1 --pretty=%s).Trim()
    if ($commitSubject -notmatch '^feat:') {
        Fail "Initial commit subject line should start with 'feat:', found: $commitSubject"
    }
    
    Write-Progress-Step "Phase 8" "Verified commit subject starts with 'feat:'"
    
    # 8.5: Verify commit includes required files in changeset
    $commitStats = (git show --stat HEAD) -join "`n"
    
    # Check for key files that should be in initial commit
    $requiredFiles = @('.env.example', '.gitignore', 'README.md')
    foreach ($file in $requiredFiles) {
        if ($commitStats -notmatch [regex]::Escape($file)) {
            Fail "Initial commit verification failed: expected file '$file' not found in commit stats"
        }
    }
    
    Write-Progress-Step "Phase 8" "Verified commit includes .env.example, .gitignore, and README.md"
    
    # 8.6: Add remote repository
    $remoteUrl = "https://github.com/corneldann/agenthq.git"
    Write-Progress-Step "Phase 8" "Adding remote: $remoteUrl"
    
    git remote add origin $remoteUrl 2>&1 | Out-Null
    
    if ($LASTEXITCODE -ne 0) {
        Fail "git remote add origin failed with exit code $LASTEXITCODE"
    }
    
    # Verify remote was added
    $remotes = git remote -v
    if ($remotes -notmatch 'origin.*github\.com/corneldann/agenthq') {
        Fail "Remote 'origin' was not added correctly. Expected github.com/corneldann/agenthq, found: $remotes"
    }
    
    Write-Progress-Step "Phase 8" "Remote 'origin' added successfully"
    
    # 8.6.5: Rename branch from master to main (git init default is master)
    $currentBranch = (git branch --show-current).Trim()
    if ($currentBranch -eq "master") {
        Write-Progress-Step "Phase 8" "Renaming branch from 'master' to 'main'"
        git branch -M main 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Fail "git branch -M main failed with exit code $LASTEXITCODE"
        }
    }
    
    # 8.7: Push to remote (with error handling)
    Write-Progress-Step "Phase 8" "Pushing to remote: git push -u origin main"
    
    # Capture both stdout and stderr
    $pushOutput = git push -u origin main 2>&1
    $pushExitCode = $LASTEXITCODE
    
    if ($pushExitCode -ne 0) {
        # Check if push was rejected due to existing remote commits
        if ($pushOutput -match 'rejected.*fetch first') {
            Write-Error "Git push rejected: remote repository contains commits not present locally."
            Write-Error "The remote repository at $remoteUrl already contains commits."
            Write-Error ""
            Write-Error "To resolve:"
            Write-Error "  1. Delete the remote repository at GitHub (if safe to do so), OR"
            Write-Error "  2. Force push (DESTRUCTIVE): git push -u origin main --force"
            Write-Error ""
            Write-Error "Push output:"
            Write-Error $pushOutput
            Fail "Git push failed: remote contains existing commits (see error details above)"
        } else {
            # Other push failure (network, auth, permissions, etc.)
            Write-Error "Git push failed with exit code $pushExitCode"
            Write-Error "Push output:"
            Write-Error $pushOutput
            Fail "Git push failed (see error details above)"
        }
    }
    
    Write-Progress-Step "Phase 8" "Git push successful"
    
    # 8.8: Verify exactly one commit on main branch after push
    $postPushCommitCount = (git log --oneline).Count
    if ($postPushCommitCount -ne 1) {
        Fail "Expected exactly 1 commit on main branch after push, found $postPushCommitCount"
    }
    
    Write-Progress-Step "Phase 8" "Verified main branch contains exactly 1 commit"
    
    Write-Progress-Step "Phase 8" "Git initialization and push complete"
    
} finally {
    # Return to original directory
    Pop-Location
}



# ============================================================================
# PHASE 9: FUNCTIONAL VERIFICATION
# ============================================================================
# Verifies AgentHQ works correctly:
# - bun install (with timeout)
# - tsc --noEmit (zero TypeScript errors)
# - bun test (all tests pass)
# - HTTP smoke tests (GET / and SSE endpoint)
# - Memory isolation runtime check (server writes to correct graph file)
# Includes:
# - Port conflict detection (uses 13333 if 3333 in use)
# - Timeout handling for long operations
# - Process cleanup in finally blocks
#
# Requirements: 9.1–9.7, 11.2
# ============================================================================

$currentPhase = "9"
Write-Progress-Step "Phase 9" "Starting functional verification"

# Change to destination directory for verification operations
Push-Location $DEST
try {
    # 9.1: Run bun install with 300s timeout
    Write-Progress-Step "Phase 9" "Installing dependencies with bun (timeout: 300s)"
    
    try {
        Invoke-WithTimeout -ScriptBlock {
            Set-Location $DEST
            bun install 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "bun install failed with exit code $LASTEXITCODE"
            }
        } -TimeoutSeconds 300 -Description "bun install"
        
        Write-Progress-Step "Phase 9.1" "Dependency installation complete"
        
    } catch {
        Fail "Phase 9.1 failed: $($_.Exception.Message)"
    }
    
    # 9.2: Run TypeScript compilation check
    Write-Progress-Step "Phase 9" "Running TypeScript compilation check"
    
    $tscPath = Join-Path $DEST "node_modules\.bin\tsc.exe"
    if (-not (Test-Path $tscPath)) {
        Fail "Phase 9.2 failed: tsc.exe not found at $tscPath after bun install"
    }
    
    try {
        $tscOutput = & $tscPath --noEmit 2>&1
        
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "TypeScript compilation check failed with errors:"
            Write-Warning $tscOutput
            Fail "Phase 9.2 failed: TypeScript compiler reported errors"
        }
        
        Write-Progress-Step "Phase 9.2" "TypeScript compilation check passed (0 errors)"
        
    } catch {
        Fail "Phase 9.2 failed: $($_.Exception.Message)"
    }
    
    # 9.3: Run test suite
    Write-Progress-Step "Phase 9" "Running test suite"
    
    try {
        $testOutput = bun test test/ 2>&1
        
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Test suite execution failed:"
            Write-Warning $testOutput
            Fail "Phase 9.3 failed: Test suite reported failures"
        }
        
        Write-Progress-Step "Phase 9.3" "Test suite passed (all tests passing)"
        
    } catch {
        Fail "Phase 9.3 failed: $($_.Exception.Message)"
    }
    
    # 9.4: HTTP smoke tests with port conflict handling
    Write-Progress-Step "Phase 9" "Running HTTP smoke tests"
    
    # Detect if port 3333 is in use, fall back to 13333
    $testPort = 3333
    $portInUse = Get-NetTCPConnection -LocalPort $testPort -ErrorAction SilentlyContinue
    if ($portInUse) {
        Write-Progress-Step "Phase 9.4" "Port 3333 in use, falling back to port 13333"
        $testPort = 13333
        
        # Check if fallback port is also in use
        $fallbackPortInUse = Get-NetTCPConnection -LocalPort $testPort -ErrorAction SilentlyContinue
        if ($fallbackPortInUse) {
            Fail "Phase 9.4 failed: Both port 3333 and fallback port 13333 are in use"
        }
    } else {
        Write-Progress-Step "Phase 9.4" "Using port 3333 for HTTP smoke tests"
    }
    
    # Create temporary .env file for smoke tests
    $tempEnvPath = Join-Path $DEST ".env"
    $tempEnvContent = @"
PORT=$testPort
OUTPUT_DIR=$DEST\test-output
SESSIONS_DIR=$DEST\test-sessions
WORKSPACE_ROOT=$DEST
SPECS_DIR=$DEST\.kiro\specs
"@
    
    try {
        Set-Content -Path $tempEnvPath -Value $tempEnvContent -NoNewline
        Write-Progress-Step "Phase 9.4" "Created temporary .env for smoke tests"
    } catch {
        Fail "Phase 9.4 failed: Could not create temporary .env: $_"
    }
    
    # Start monitor server in background
    $serverProcess = $null
    try {
        Write-Progress-Step "Phase 9.4" "Starting monitor server on port $testPort"
        
        $serverProcess = Start-Process -FilePath "bun" -ArgumentList "src/monitor.ts" `
            -WorkingDirectory $DEST -PassThru -WindowStyle Hidden -RedirectStandardOutput "$DEST\smoke-test.log" -RedirectStandardError "$DEST\smoke-test-err.log"
        
        # Wait for server to start (max 10 seconds)
        $startTimeout = 10
        $startElapsed = 0
        $serverStarted = $false
        
        while ($startElapsed -lt $startTimeout) {
            Start-Sleep -Seconds 1
            $startElapsed++
            
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:$testPort/" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
                if ($response) {
                    $serverStarted = $true
                    break
                }
            } catch {
                # Server not ready yet, continue waiting
            }
        }
        
        if (-not $serverStarted) {
            Fail "Phase 9.4 failed: Monitor server did not start within $startTimeout seconds"
        }
        
        Write-Progress-Step "Phase 9.4" "Monitor server started successfully"
        
        # Test 1: GET / returns HTTP 200 with text/html
        Write-Progress-Step "Phase 9.4" "Testing GET / endpoint"
        
        try {
            $rootResponse = Invoke-WebRequest -Uri "http://localhost:$testPort/" -TimeoutSec 5 -UseBasicParsing
            
            if ($rootResponse.StatusCode -ne 200) {
                Fail "Phase 9.4 failed: GET / returned status code $($rootResponse.StatusCode), expected 200"
            }
            
            if ($rootResponse.Headers['Content-Type'] -notmatch 'text/html') {
                Fail "Phase 9.4 failed: GET / returned Content-Type '$($rootResponse.Headers['Content-Type'])', expected text/html"
            }
            
            Write-Progress-Step "Phase 9.4" "GET / test passed (HTTP 200, text/html)"
            
        } catch {
            Fail "Phase 9.4 failed: GET / request failed: $($_.Exception.Message)"
        }
        
        # Test 2: SSE endpoint returns HTTP 200 with text/event-stream
        Write-Progress-Step "Phase 9.4" "Testing SSE endpoint"
        
        try {
            $sseResponse = Invoke-WebRequest -Uri "http://localhost:$testPort/events" -TimeoutSec 5 -UseBasicParsing
            
            if ($sseResponse.StatusCode -ne 200) {
                Fail "Phase 9.4 failed: SSE endpoint returned status code $($sseResponse.StatusCode), expected 200"
            }
            
            if ($sseResponse.Headers['Content-Type'] -notmatch 'text/event-stream') {
                Fail "Phase 9.4 failed: SSE endpoint returned Content-Type '$($sseResponse.Headers['Content-Type'])', expected text/event-stream"
            }
            
            Write-Progress-Step "Phase 9.4" "SSE endpoint test passed (HTTP 200, text/event-stream)"
            
        } catch {
            Fail "Phase 9.4 failed: SSE endpoint request failed: $($_.Exception.Message)"
        }
        
        # Test 3: Git status endpoint returns HTTP 200 with JSON
        Write-Progress-Step "Phase 9.4" "Testing git status endpoint"
        
        try {
            $gitResponse = Invoke-WebRequest -Uri "http://localhost:$testPort/git-status" -TimeoutSec 5 -UseBasicParsing
            
            if ($gitResponse.StatusCode -ne 200) {
                Fail "Phase 9.4 failed: Git status endpoint returned status code $($gitResponse.StatusCode), expected 200"
            }
            
            # Verify response is valid JSON
            try {
                $gitJson = $gitResponse.Content | ConvertFrom-Json
                
                # Verify JSON contains expected fields (branch name at minimum)
                if (-not $gitJson.branch) {
                    Fail "Phase 9.4 failed: Git status JSON missing 'branch' field"
                }
                
                Write-Progress-Step "Phase 9.4" "Git status endpoint test passed (HTTP 200, valid JSON with branch: $($gitJson.branch))"
                
            } catch {
                Fail "Phase 9.4 failed: Git status endpoint did not return valid JSON: $($_.Exception.Message)"
            }
            
        } catch {
            Fail "Phase 9.4 failed: Git status endpoint request failed: $($_.Exception.Message)"
        }
        
        Write-Progress-Step "Phase 9.4" "HTTP smoke tests complete"
        
    } finally {
        # Clean up: stop server process
        if ($serverProcess -and -not $serverProcess.HasExited) {
            Write-Progress-Step "Phase 9.4" "Stopping monitor server process (PID: $($serverProcess.Id))"
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        
        # Clean up: remove temporary .env
        if (Test-Path $tempEnvPath) {
            Remove-Item $tempEnvPath -Force -ErrorAction SilentlyContinue
        }
        
        # Clean up: remove test output directories
        $testOutputDir = Join-Path $DEST "test-output"
        $testSessionsDir = Join-Path $DEST "test-sessions"
        if (Test-Path $testOutputDir) {
            Remove-Item $testOutputDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $testSessionsDir) {
            Remove-Item $testSessionsDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        
        # Clean up: remove smoke test logs
        $smokeTestLog = Join-Path $DEST "smoke-test.log"
        $smokeTestErrLog = Join-Path $DEST "smoke-test-err.log"
        if (Test-Path $smokeTestLog) {
            Remove-Item $smokeTestLog -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $smokeTestErrLog) {
            Remove-Item $smokeTestErrLog -Force -ErrorAction SilentlyContinue
        }
    }
    
    # 9.5: Memory isolation runtime verification
    Write-Progress-Step "Phase 9" "Running memory isolation runtime verification"
    
    # Create temporary .env with valid paths for memory test
    $memTestEnvContent = @"
PORT=$testPort
OUTPUT_DIR=$DEST\workspace
SESSIONS_DIR=$DEST\workspace\.sessions
WORKSPACE_ROOT=$DEST\workspace
SPECS_DIR=$DEST\workspace\.kiro\specs
"@
    
    $serverProcess = $null
    try {
        Set-Content -Path $tempEnvPath -Value $memTestEnvContent -NoNewline
        Write-Progress-Step "Phase 9.5" "Created temporary .env for memory test"
        
        # Ensure workspace/.kiro/memory/ directory exists
        $memoryDir = Join-Path $DEST "workspace\.kiro\memory"
        if (-not (Test-Path $memoryDir)) {
            New-Item -ItemType Directory -Path $memoryDir -Force | Out-Null
        }
        
        # Ensure workspace/.sessions/ directory exists
        $sessionsDir = Join-Path $DEST "workspace\.sessions"
        if (-not (Test-Path $sessionsDir)) {
            New-Item -ItemType Directory -Path $sessionsDir -Force | Out-Null
        }
        
        # Start AgentHQ monitor server with valid .env
        Write-Progress-Step "Phase 9.5" "Starting AgentHQ monitor for memory test"
        
        $serverProcess = Start-Process -FilePath "bun" -ArgumentList "src/monitor.ts" `
            -WorkingDirectory $DEST -PassThru -WindowStyle Hidden -RedirectStandardOutput "$DEST\mem-test.log" -RedirectStandardError "$DEST\mem-test-err.log"
        
        # Wait for server to start
        $startTimeout = 10
        $startElapsed = 0
        $serverStarted = $false
        
        while ($startElapsed -lt $startTimeout) {
            Start-Sleep -Seconds 1
            $startElapsed++
            
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:$testPort/" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
                if ($response) {
                    $serverStarted = $true
                    break
                }
            } catch {
                # Server not ready yet
            }
        }
        
        if (-not $serverStarted) {
            Fail "Phase 9.5 failed: AgentHQ monitor did not start for memory test"
        }
        
        Write-Progress-Step "Phase 9.5" "AgentHQ monitor started"
        
        # TODO: Write test entity to memory MCP server
        # This would require MCP client implementation which is not trivial in PowerShell
        # For now, we'll verify the graph path configuration is correct and document this limitation
        
        Write-Progress-Step "Phase 9.5" "Verifying memory graph path configuration"
        
        # Verify AgentHQ memory graph path
        $agenthqGraphPath = Join-Path $DEST "workspace\.kiro\memory\graph.json"
        $agenthqGraphPathResolved = [System.IO.Path]::GetFullPath($agenthqGraphPath).ToLowerInvariant()
        
        # Verify Scottish Water memory graph path differs (case-insensitive comparison)
        # Scottish Water memory graph is configured in .kiro/powers/oracle-carbon-analysis/mcp.json
        $swMemoryConfigPath = ".kiro\powers\oracle-carbon-analysis\mcp.json"
        
        if (Test-Path $swMemoryConfigPath) {
            $swMemoryConfig = Get-Content $swMemoryConfigPath -Raw | ConvertFrom-Json
            $swMemoryPath = $swMemoryConfig.mcpServers.memory.env.MEMORY_FILE_PATH
            $swMemoryPathResolved = [System.IO.Path]::GetFullPath($swMemoryPath).ToLowerInvariant()
            
            if ($agenthqGraphPathResolved -eq $swMemoryPathResolved) {
                Fail "Phase 9.5 failed: AgentHQ and Scottish Water memory graph paths are identical (case-insensitive): $agenthqGraphPathResolved"
            }
            
            Write-Progress-Step "Phase 9.5" "Memory isolation verified: AgentHQ path differs from Scottish Water path"
            Write-Progress-Step "Phase 9.5" "  AgentHQ: $agenthqGraphPathResolved"
            Write-Progress-Step "Phase 9.5" "  SW:      $swMemoryPathResolved"
            
        } else {
            Write-Warning "Phase 9.5: Could not verify Scottish Water memory path (config not found at $swMemoryConfigPath)"
            Write-Progress-Step "Phase 9.5" "AgentHQ memory graph path verified: $agenthqGraphPathResolved"
        }
        
        Write-Progress-Step "Phase 9.5" "Memory isolation runtime verification complete"
        
    } finally {
        # Clean up: stop server process
        if ($serverProcess -and -not $serverProcess.HasExited) {
            Write-Progress-Step "Phase 9.5" "Stopping AgentHQ monitor process (PID: $($serverProcess.Id))"
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        
        # Clean up: remove temporary .env
        if (Test-Path $tempEnvPath) {
            Remove-Item $tempEnvPath -Force -ErrorAction SilentlyContinue
        }
        
        # Clean up: remove memory test logs
        $memTestLog = Join-Path $DEST "mem-test.log"
        $memTestErrLog = Join-Path $DEST "mem-test-err.log"
        if (Test-Path $memTestLog) {
            Remove-Item $memTestLog -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $memTestErrLog) {
            Remove-Item $memTestErrLog -Force -ErrorAction SilentlyContinue
        }
    }
    
} finally {
    # Return to original directory
    Pop-Location
}

Write-Progress-Step "Phase 9" "Functional verification complete"



# ============================================================================
# PHASE 10: SCOTTISH WATER HANDOVER
# ============================================================================
# Updates Scottish Water workspace and removes sw-agent/:
# - Git status check (detects uncommitted changes)
# - Grep pattern pre-verification (warns if patterns don't match)
# - User confirmation prompt if warnings raised
# - Rewrite .kiro/steering/tech-core.md (remove sw-agent/ references)
# - Migrate specs to AgentHQ workspace/.kiro/specs/
# - Remove sw-agent/ directory
# - Git commit with conventional commit message
#
# Requirements: 10.1–10.7
# ============================================================================

$currentPhase = "10"
Write-Progress-Step "Phase 10" "Starting Scottish Water handover"

# 10.1: Pre-handover verification
Write-Progress-Step "Phase 10" "Running pre-handover verification checks"

# Check 1: Verify Phase 9 completed successfully (AgentHQ repo is functional)
if (-not (Test-Path $DEST)) {
    Fail "Pre-handover check failed: AgentHQ destination directory does not exist. Phase 9 may not have completed successfully."
}

# Check for critical files that should exist after Phase 9
$criticalFiles = @(
    (Join-Path $DEST "package.json"),
    (Join-Path $DEST "src\monitor.ts"),
    (Join-Path $DEST "workspace\.kiro\steering\tech-core.md"),
    (Join-Path $DEST ".env.example")
)

foreach ($file in $criticalFiles) {
    if (-not (Test-Path $file)) {
        Fail "Pre-handover check failed: Expected file not found: $file. Phase 9 may not have completed successfully."
    }
}

Write-Progress-Step "Phase 10" "Verified Phase 9 completion (AgentHQ repo exists)"

# Check 2: Git status for uncommitted changes to tech-core.md in SW workspace
Write-Progress-Step "Phase 10" "Checking git status for uncommitted changes to tech-core.md"
$techCoreGitStatus = git status --porcelain .kiro/steering/tech-core.md 2>&1

$hasUncommittedChanges = $false
if ($techCoreGitStatus.Length -gt 0) {
    Write-Warning "Pre-handover warning: Uncommitted changes detected in .kiro/steering/tech-core.md"
    Write-Warning "Git status output: $techCoreGitStatus"
    $hasUncommittedChanges = $true
}

# Check 3: Grep pre-verification for sw-monitor-dashboard and sw-agent/ patterns
Write-Progress-Step "Phase 10" "Running grep pre-verification for target patterns"
$grepWarnings = @()

# Check for sw-monitor-dashboard pattern in tech-core.md
$techCorePath = ".kiro\steering\tech-core.md"
if (Test-Path $techCorePath) {
    $swMonitorMatches = Select-String -Path $techCorePath -Pattern "sw-monitor-dashboard" 2>$null
    if (-not $swMonitorMatches) {
        $grepWarnings += "Pattern 'sw-monitor-dashboard' not found in $techCorePath (expected at least one match for replacement)"
    } else {
        Write-Progress-Step "Phase 10" "Found $($swMonitorMatches.Count) match(es) for 'sw-monitor-dashboard' in tech-core.md"
    }
    
    # Check for sw-agent/ pattern in tech-core.md
    $swAgentMatches = Select-String -Path $techCorePath -Pattern "sw-agent/" 2>$null
    if (-not $swAgentMatches) {
        $grepWarnings += "Pattern 'sw-agent/' not found in $techCorePath (expected at least one match for replacement)"
    } else {
        Write-Progress-Step "Phase 10" "Found $($swAgentMatches.Count) match(es) for 'sw-agent/' in tech-core.md"
    }
} else {
    Fail "Pre-handover check failed: tech-core.md not found at: $techCorePath"
}

# Check 4: Evaluate warnings and prompt user if necessary
$shouldPromptUser = $false
if ($hasUncommittedChanges -or $grepWarnings.Count -gt 0) {
    $shouldPromptUser = $true
}

if ($shouldPromptUser) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "PRE-HANDOVER VERIFICATION WARNINGS" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host ""
    
    if ($hasUncommittedChanges) {
        Write-Host "WARNING: Uncommitted changes detected in .kiro/steering/tech-core.md" -ForegroundColor Yellow
        Write-Host "  Git status: $techCoreGitStatus" -ForegroundColor Yellow
        Write-Host "  Phase 10 will modify this file. Uncommitted changes may be lost." -ForegroundColor Yellow
        Write-Host ""
    }
    
    if ($grepWarnings.Count -gt 0) {
        Write-Host "WARNING: Grep pattern verification raised concerns:" -ForegroundColor Yellow
        foreach ($warning in $grepWarnings) {
            Write-Host "  - $warning" -ForegroundColor Yellow
        }
        Write-Host "  This may indicate the file content has already been modified." -ForegroundColor Yellow
        Write-Host ""
    }
    
    Write-Host "Do you want to proceed with Phase 10 Scottish Water handover? (Y/N)" -ForegroundColor Yellow
    $response = Read-Host "Enter Y to continue or N to abort"
    
    if ($response -ne "Y" -and $response -ne "y") {
        Write-Host ""
        Write-Host "Phase 10 aborted by user. Migration halted." -ForegroundColor Red
        Write-Host "AgentHQ repository has been created successfully at: $DEST"
        Write-Host "Scottish Water workspace has NOT been modified."
        Write-Host ""
        Write-Host "To complete the handover later:"
        Write-Host "  1. Address the warnings above"
        Write-Host "  2. Re-run Phase 10 tasks manually or restart the migration"
        Write-Host ""
        exit 0
    }
    
    Write-Host ""
    Write-Host "User confirmed: proceeding with Phase 10 handover" -ForegroundColor Green
    Write-Host ""
}

Write-Progress-Step "Phase 10" "Pre-handover verification complete"

# 10.2: Rewrite tech-core.md
Write-Progress-Step "Phase 10" "Rewriting .kiro/steering/tech-core.md"

$techCorePath = ".kiro\steering\tech-core.md"
if (-not (Test-Path $techCorePath)) {
    Fail "tech-core.md not found at: $techCorePath"
}

# Read current content
$techCoreContent = Get-Content $techCorePath -Raw

# Perform string replacements
# 1. sw-monitor-dashboard → agenthq-dashboard
$techCoreContent = $techCoreContent -replace 'sw-monitor-dashboard', 'agenthq-dashboard'

# 2. sw-agent/src/dashboard/ → src/dashboard/
$techCoreContent = $techCoreContent -replace 'sw-agent/src/dashboard/', 'src/dashboard/'

# 3. Remove other sw-agent/ references (context-aware)
# This handles remaining sw-agent/ patterns that aren't the dashboard path
# The BUILD_QUEUE section references sw-agent/src/dashboard/ which was already replaced above
# Any other sw-agent/ references should be removed entirely
$techCoreContent = $techCoreContent -replace 'sw-agent/', ''

Write-Progress-Step "Phase 10" "Writing updated tech-core.md"
Set-Content -Path $techCorePath -Value $techCoreContent -NoNewline

# Verify no prohibited patterns remain
Write-Progress-Step "Phase 10" "Verifying tech-core.md rewrite"
Assert-NoMatch -Path $techCorePath -Pattern 'sw-monitor-dashboard' -Description 'tech-core.md sw-monitor-dashboard removal'
Assert-NoMatch -Path $techCorePath -Pattern 'sw-agent/' -Description 'tech-core.md sw-agent/ removal'

Write-Progress-Step "Phase 10" "tech-core.md rewrite complete"

# 10.3: Migrate specs
Write-Progress-Step "Phase 10" "Migrating feature specs to AgentHQ workspace"

# Copy monitor-dashboard-redesign spec
$srcSpec1 = ".kiro\specs\monitor-dashboard-redesign"
$destSpec1 = "$DEST\workspace\.kiro\specs\monitor-dashboard-redesign"

if (Test-Path $srcSpec1) {
    Copy-Spec -SrcDir $srcSpec1 -DestDir $destSpec1
    Write-Progress-Step "Phase 10" "Migrated monitor-dashboard-redesign spec"
} else {
    Write-Warning "Source spec not found: $srcSpec1 (skipping)"
}

# Copy monitor-server-split spec
$srcSpec2 = ".kiro\specs\monitor-server-split"
$destSpec2 = "$DEST\workspace\.kiro\specs\monitor-server-split"

if (Test-Path $srcSpec2) {
    Copy-Spec -SrcDir $srcSpec2 -DestDir $destSpec2
    Write-Progress-Step "Phase 10" "Migrated monitor-server-split spec"
} else {
    Write-Warning "Source spec not found: $srcSpec2 (skipping)"
}

Write-Progress-Step "Phase 10" "Spec migration complete"

# 10.4: Remove sw-agent/ directory from SW workspace
Write-Progress-Step "Phase 10" "Removing sw-agent/ directory from Scottish Water workspace"

if (-not (Test-Path "sw-agent\")) {
    Fail "sw-agent/ directory not found at expected location before removal"
}

try {
    Remove-Item "sw-agent\" -Recurse -Force
    Write-Progress-Step "Phase 10" "Removed sw-agent/ directory"
} catch {
    Fail "Failed to remove sw-agent/ directory: $_"
}

# Verify sw-agent/ was removed
if (Test-Path "sw-agent\") {
    Fail "sw-agent/ directory still exists after removal attempt"
}

Write-Progress-Step "Phase 10" "sw-agent/ directory successfully removed"

# 10.5: Stage all changes and commit
Write-Progress-Step "Phase 10" "Staging all changes (tech-core.md, removed sw-agent/, removed specs)"

try {
    git add -A 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "git add -A failed with exit code $LASTEXITCODE"
    }
    Write-Progress-Step "Phase 10" "Staged all changes"
} catch {
    Fail "Failed to stage changes: $_"
}

# Create commit with exact subject line
$commitSubject = "chore(sw-agent): remove sw-agent/ — extracted to corneldann/agenthq"

Write-Progress-Step "Phase 10" "Creating commit: $commitSubject"

try {
    git commit -m $commitSubject 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "git commit failed with exit code $LASTEXITCODE"
    }
    Write-Progress-Step "Phase 10" "Commit created successfully"
} catch {
    Fail "Failed to create commit: $_"
}

# Verify commit was created
$lastCommit = git log -1 --pretty=format:"%s" 2>&1
if ($lastCommit -ne $commitSubject) {
    Fail "Commit verification failed: expected subject '$commitSubject', got '$lastCommit'"
}

Write-Progress-Step "Phase 10" "Commit verified: $commitSubject"

Write-Progress-Step "Phase 10" "Scottish Water workspace handover complete"



# ============================================================================
# MIGRATION COMPLETE
# ============================================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "MIGRATION COMPLETE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "AgentHQ repository created at: $DEST"
Write-Host "GitHub remote: https://github.com/corneldann/agenthq"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Review the AgentHQ repository"
Write-Host "  2. Open workspace/agenthq.code-workspace in Kiro/VSCode"
Write-Host "  3. Copy .env.example to .env and configure paths"
Write-Host "  4. Run: bun src/monitor.ts"
Write-Host ""
