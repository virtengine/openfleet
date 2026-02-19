#!/usr/bin/env pwsh
<#
.SYNOPSIS
    VirtEngine Task Orchestrator — automated task chaining with parallel execution.

.DESCRIPTION
    Long-running orchestration loop that:
    1. Maintains a target number of parallel task attempts
    2. Cycles agents 50/50 between Codex and Copilot to avoid rate-limiting
    3. Monitors agent completion (PR creation) and CI status
    4. Auto-merges PRs when CI passes
    5. Ensures previous tasks are merged before starting new ones
    6. Marks completed tasks as done
    7. Submits the next todo task to fill the slot
    8. Repeats until the backlog is empty

.PARAMETER MaxParallel
    Maximum number of concurrent task attempts (default: 2).

.PARAMETER PollIntervalSec
    Seconds between orchestration cycles (default: 300 = 5 minutes).

.PARAMETER DryRun
    If set, logs what would happen without making changes.

.PARAMETER WaitForMutex
    If set, waits for an existing orchestrator instance to release the mutex.

.PARAMETER OneShot
    Run a single orchestration cycle and exit (useful for testing).

.EXAMPLE
    # Run with 2 parallel agents, polling every 5 minutes
    ./ve-orchestrator.ps1

    # Run with 3 parallel agents, polling every 3 minutes
    ./ve-orchestrator.ps1 -MaxParallel 3 -PollIntervalSec 180

    # Dry-run to see what would happen
    ./ve-orchestrator.ps1 -DryRun

    # Single cycle (no loop)
    ./ve-orchestrator.ps1 -OneShot
#>
[CmdletBinding()]
param(
    [int]$MaxParallel = 2,
    [int]$PollIntervalSec = 90,
    [int]$GitHubCooldownSec = 120,
    [int]$VKApiTimeoutSec = 20,
    [int]$VKApiRetryCount = 3,
    [int]$VKApiRetryDelaySec = 5,
    [int]$GitHubCommandTimeoutSec = 120,
    [int]$IdleTimeoutMin = 60,
    [int]$IdleConfirmMin = 15,
    [int]$StaleRunningTimeoutMin = 90,
    [int]$SetupTimeoutMin = 30,
    [int]$CiWaitMin = 15,
    [int]$MaxRetries = 5,
    [bool]$UseAutoMerge = $true,
    [switch]$UseAdminMerge,
    [switch]$WaitForMutex,
    [switch]$DryRun,
    [switch]$OneShot,
    [switch]$RunMergeStrategy,
    [switch]$SyncCopilotState
)

# ─── Load ve-kanban library ──────────────────────────────────────────────────
function Get-VeKanbanLibraryCandidates {
    $candidates = @()
    if ($PSScriptRoot) {
        $candidates += (Join-Path $PSScriptRoot "ve-kanban.ps1")
        $candidates += (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "ve-kanban.ps1")
        $candidates += (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "scripts\\ve-kanban.ps1")
    }
    if ($PSCommandPath) {
        $candidates += (Join-Path (Split-Path -Parent $PSCommandPath) "ve-kanban.ps1")
    }
    $candidates += (Join-Path (Get-Location) "ve-kanban.ps1")
    $candidates = $candidates | Select-Object -Unique

    return $candidates
}

$script:VeKanbanLibraryCandidates = Get-VeKanbanLibraryCandidates
$script:VeKanbanLibraryPath = $null
foreach ($path in $script:VeKanbanLibraryCandidates) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $script:VeKanbanLibraryPath = $path
    break
}
if (-not $script:VeKanbanLibraryPath) {
    throw "ve-kanban library not found. Tried: $($script:VeKanbanLibraryCandidates -join ', ')"
}
try {
    . $script:VeKanbanLibraryPath
}
catch {
    throw "Failed to load ve-kanban library from '$script:VeKanbanLibraryPath': $($_.Exception.Message)"
}

$requiredFunctions = @(
    "Initialize-VKConfig",
    "Get-VKTasks",
    "Get-VKAttempts",
    "Get-VKAttemptSummaries",
    "Get-OpenPullRequests",
    "Get-VKLastGithubError",
    "Get-CurrentExecutorProfile",
    "Get-NextExecutorProfile"
)
function Ensure-VeKanbanLibraryLoaded {
    param([string[]]$RequiredFunctions)
    $missing = $RequiredFunctions | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
    if ($missing.Count -eq 0) { return $true }

    # Retry dot-sourcing in case the initial load occurred in a narrower scope.
    try {
        . $script:VeKanbanLibraryPath
    }
    catch {
        Write-Error "Failed to reload ve-kanban library from '$script:VeKanbanLibraryPath': $($_.Exception.Message)"
    }

    $missing = $RequiredFunctions | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
    if ($missing.Count -eq 0) { return $true }

    # Final fallback: import as a module to force global visibility.
    try {
        Import-Module -Name $script:VeKanbanLibraryPath -Force -Global
    }
    catch {
        Write-Error "Failed to import ve-kanban library module from '$script:VeKanbanLibraryPath': $($_.Exception.Message)"
    }

    $missing = $RequiredFunctions | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
    if ($missing.Count -gt 0) {
        throw "ve-kanban library loaded but missing required functions: $($missing -join ', ')"
    }
    return $true
}

Ensure-VeKanbanLibraryLoaded -RequiredFunctions $requiredFunctions | Out-Null

# ─── Agent Work Logger ───────────────────────────────────────────────────────
$script:AgentWorkLoggerPath = Join-Path $PSScriptRoot "lib\agent-work-logger.ps1"
if (Test-Path $script:AgentWorkLoggerPath) {
    try {
        . $script:AgentWorkLoggerPath
        $script:AgentWorkLoggerEnabled = $true
        Write-Host "[orchestrator] Agent work logger loaded from $($script:AgentWorkLoggerPath)" -ForegroundColor Cyan
    }
    catch {
        Write-Warning "[orchestrator] Failed to load agent-work-logger: $($_.Exception.Message)"
        $script:AgentWorkLoggerEnabled = $false
    }
}
else {
    Write-Warning "[orchestrator] Agent work logger not found at $($script:AgentWorkLoggerPath)"
    $script:AgentWorkLoggerEnabled = $false
}

# ─── State tracking ──────────────────────────────────────────────────────────
$script:CycleCount = 0
$script:TasksCompleted = 0
$script:TotalTasksCompleted = 0
$script:TasksSubmitted = 0
$script:StartTime = Get-Date
$script:GitHubCooldownUntil = $null
$script:TaskRetryCounts = @{}
$script:AttemptSummaries = @{}
$script:TaskFollowUpCounts = @{}  # Per-task follow-up counter to prevent infinite loops
$script:MAX_FOLLOWUPS_PER_TASK = 6  # Hard cap on follow-ups per task before marking manual_review
$script:StatePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-orchestrator-state.json"
$script:CopilotStatePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-orchestrator-copilot.json"
$script:StatusStatePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-orchestrator-status.json"
$script:PauseStatePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-orchestrator-pause.json"
$script:StopFilePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-orchestrator-stop"
$script:RebaseCooldownPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-rebase-cooldown.json"
$script:AgentLogDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\agent-logs"
$script:AnomalySignalPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\anomaly-signals.json"
$script:CODEX_TAKEOVER_THRESHOLD = 3  # After N failed attempts, switch to Codex SDK CLI
$script:CodexTakeoverJobs = @{}  # Track Codex CLI takeover jobs
$script:CompletedTasks = @()
$script:SubmittedTasks = @()
$script:FollowUpEvents = @()
$script:CopilotRequests = @()
$script:SlotMetrics = @{
    last_sample_at         = $null
    total_idle_seconds     = 0.0
    total_capacity_seconds = 0.0
    last_snapshot          = $null
}

function Get-GlobalPauseState {
    try {
        if (Test-Path $script:PauseStatePath) {
            $raw = Get-Content -Path $script:PauseStatePath -Raw
            if ($raw) { return ($raw | ConvertFrom-Json) }
        }
    }
    catch {
        Write-Warning "[orchestrator] Failed to read pause state: $($_.Exception.Message)"
    }
    return @{ paused = $false; reason = $null; pauseUntil = $null; updatedAt = $null; source = $null }
}

function Test-GlobalPause {
    $state = Get-GlobalPauseState
    if ($state -and ($state.paused -eq $true)) { return $true }
    return $false
}

$script:CiSweepEvery = $null
$script:CiSweepPrEvery = $null
$script:CiSweepPrBackupEnabled = $true
$script:LastCISweepAt = $null

# ─── Success rate tracking ────────────────────────────────────────────────────
$script:FirstShotSuccess = 0          # Merged on first attempt, no copilot fix
$script:TasksNeededFix = 0            # Required copilot sub-PR or manual intervention
$script:TasksFailed = 0               # Abandoned / rejected / manual_review
$script:SuccessMetricsPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-success-metrics.json"
$script:OrchestratorMutex = $null
$script:StopRequested = $false
$script:StopReason = $null

# Track attempts we're monitoring: attempt_id → { task_id, branch, pr_number, status, executor }
$script:TrackedAttempts = @{}

# Exclusion set: attempts fully processed but unable to archive server-side (HTTP 405/409).
# Prevents infinite re-tracking when Get-VKAttempts keeps returning un-archivable attempts.
# Persisted to disk so it survives orchestrator restarts.
$script:ProcessedAttemptIds = [System.Collections.Generic.HashSet[string]]::new()
$script:ProcessedAttemptIdsPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".cache\ve-processed-attempt-ids.json"

# Merge gate: track tasks that completed their PR but haven't been merged yet
# This ensures we don't start new tasks until previous ones are merged & confirmed
$script:PendingMerges = @{}

# ─── Logging ──────────────────────────────────────────────────────────────────
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "HH:mm:ss"
    $color = switch ($Level) {
        "INFO" { "White" }
        "OK" { "Green" }
        "WARN" { "Yellow" }
        "ERROR" { "Red" }
        "ACTION" { "Cyan" }
        default { "Gray" }
    }
    Write-Host "  [$ts] $Message" -ForegroundColor $color
}

# ─── ProcessedAttemptIds persistence ──────────────────────────────────────────
function Save-ProcessedAttemptIds {
    <#
    .SYNOPSIS Persist the ProcessedAttemptIds set to disk as a JSON array.
    #>
    try {
        $ids = @($script:ProcessedAttemptIds)
        $dir = Split-Path $script:ProcessedAttemptIdsPath -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $ids | ConvertTo-Json -Compress | Set-Content -Path $script:ProcessedAttemptIdsPath -Encoding UTF8 -Force
    }
    catch {
        Write-Log "Failed to save ProcessedAttemptIds: $_" -Level "WARN"
    }
}

function Load-ProcessedAttemptIds {
    <#
    .SYNOPSIS Load previously persisted ProcessedAttemptIds from disk.
    #>
    if (-not (Test-Path $script:ProcessedAttemptIdsPath)) { return }
    try {
        $raw = Get-Content -Path $script:ProcessedAttemptIdsPath -Raw -ErrorAction Stop
        $ids = $raw | ConvertFrom-Json -ErrorAction Stop
        if ($ids -is [string]) { $ids = @($ids) }
        $loaded = 0
        foreach ($id in $ids) {
            if ($id -and $id -is [string]) {
                $script:ProcessedAttemptIds.Add($id) | Out-Null
                $loaded++
            }
        }
        if ($loaded -gt 0) {
            Write-Log "Loaded $loaded processed attempt IDs from disk" -Level "INFO"
        }
    }
    catch {
        Write-Log "Failed to load ProcessedAttemptIds: $_" -Level "WARN"
    }
}

function Get-EnvFallback {
    <#
    .SYNOPSIS Robust env var lookup with fallbacks.
    .DESCRIPTION Uses multiple access paths to avoid parser edge cases.
    #>
    param(
        [Parameter(Mandatory)][string]$Name
    )

    try {
        $value = [Environment]::GetEnvironmentVariable($Name)
        if ($value) { return $value }
    }
    catch { }

    try {
        $item = Get-Item -Path ("Env:{0}" -f $Name) -ErrorAction SilentlyContinue
        if ($item -and $item.Value) { return $item.Value }
    }
    catch { }

    try {
        $all = [Environment]::GetEnvironmentVariables()
        if ($all -and $all.ContainsKey($Name)) {
            $value = $all[$Name]
            if ($value) { return $value }
        }
    }
    catch { }

    return $null
}

function Set-EnvValue {
    <#
    .SYNOPSIS Robust env var setter with fallbacks.
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()][object]$Value
    )

    try {
        if ($null -eq $Value -or $Value -eq "") {
            Remove-Item -Path ("Env:{0}" -f $Name) -ErrorAction SilentlyContinue | Out-Null
        }
        else {
            Set-Item -Path ("Env:{0}" -f $Name) -Value $Value -ErrorAction SilentlyContinue | Out-Null
        }
    }
    catch { }

    try {
        [Environment]::SetEnvironmentVariable($Name, $Value)
    }
    catch { }
}

function Get-EnvInt {
    param(
        [Parameter(Mandatory)][string]$Name,
        [int]$Default,
        [int]$Min = 0
    )
    $raw = Get-EnvFallback -Name $Name
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $value = 0
    if (-not [int]::TryParse($raw, [ref]$value)) { return $Default }
    if ($value -lt $Min) { return $Min }
    return $value
}

function Get-EnvBool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [bool]$Default = $false
    )
    $raw = Get-EnvFallback -Name $Name
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    switch ($raw.Trim().ToLowerInvariant()) {
        "1" { return $true }
        "true" { return $true }
        "yes" { return $true }
        "y" { return $true }
        "on" { return $true }
        "0" { return $false }
        "false" { return $false }
        "no" { return $false }
        "n" { return $false }
        "off" { return $false }
        default { return $Default }
    }
}

function Get-EnvString {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$Default = ""
    )
    $value = Get-EnvFallback -Name $Name
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

$script:FollowUpMaxChars = Get-EnvInt -Name "VE_FOLLOWUP_MAX_CHARS" -Default 16000 -Min 2000
$script:FollowUpMaxDescriptionChars = Get-EnvInt -Name "VE_FOLLOWUP_MAX_DESC_CHARS" -Default 2000 -Min 200

function Request-OrchestratorStop {
    param([string]$Reason = "shutdown")
    if ($script:StopRequested) { return }
    $script:StopRequested = $true
    $script:StopReason = $Reason
    Write-Log "Stop requested ($Reason). Exiting after current step." -Level "WARN"
}

function Test-OrchestratorStop {
    if ($script:StopRequested) { return $true }
    if ($script:StopFilePath -and (Test-Path -LiteralPath $script:StopFilePath)) {
        Request-OrchestratorStop -Reason "stop-file"
        return $true
    }
    return $false
}

function Start-InterruptibleSleep {
    param(
        [Parameter(Mandatory)][int]$Seconds,
        [string]$Reason = "sleep"
    )
    $remaining = [Math]::Max(0, [int]$Seconds)
    while ($remaining -gt 0) {
        if (Test-OrchestratorStop) { return $false }
        $chunk = [Math]::Min(5, $remaining)
        Start-Sleep -Seconds $chunk
        $remaining -= $chunk
    }
    return $true
}

function Register-OrchestratorShutdownHandlers {
    try {
        Register-EngineEvent -SourceIdentifier "PowerShell.Exiting" -Action {
            try { Request-OrchestratorStop -Reason "PowerShell.Exiting" } catch { }
        } | Out-Null
    }
    catch { }
    try {
        Register-ObjectEvent -InputObject ([Console]) -EventName CancelKeyPress -Action {
            try { Request-OrchestratorStop -Reason "console-cancel" } catch { }
            $EventArgs.Cancel = $true
        } | Out-Null
    }
    catch { }
}

function Get-OrchestratorMutexName {
    param([string]$BaseName = "VirtEngineOrchestrator")
    $rootPath = $null
    try {
        $rootPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    }
    catch {
        $rootPath = (Get-Location).Path
    }
    if (-not $rootPath) {
        return $BaseName
    }
    $hash = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($rootPath.ToLowerInvariant())
    $digest = $hash.ComputeHash($bytes)
    $hash.Dispose()
    $hashHex = ([System.BitConverter]::ToString($digest)).Replace("-", "")
    $suffix = $hashHex.Substring(0, 12)
    return "$BaseName.$suffix"
}

function Enter-OrchestratorMutex {
    param([string]$Name = (Get-OrchestratorMutexName))
    $createdNew = $false
    # Use a plain name — skip Global\ prefix to avoid Windows session/permission errors.
    $mutexName = $Name
    $mutex = $null
    try {
        $mutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$createdNew)
    }
    catch {
        Write-Warning "Mutex creation failed: $($_.Exception.Message). Proceeding without lock."
        # Return a sentinel so the caller knows to proceed (not block).
        return [PSCustomObject]@{ NoOp = $true }
    }
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        # Previous orchestrator was killed; take ownership to avoid a deadlock loop.
        $acquired = $true
    }
    catch {
        $acquired = $false
    }
    if (-not $acquired) {
        if ($mutex) { $mutex.Dispose() }
        return $null
    }
    return $mutex
}

function Format-ShortId {
    param([string]$Value, [int]$Length = 8)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    if ($Value.Length -le $Length) { return $Value }
    return $Value.Substring(0, $Length)
}

function Write-Banner {
    $nextStr = "/"
    if (Get-Command Get-CurrentExecutorProfile -ErrorAction SilentlyContinue) {
        try {
            $nextExec = Get-CurrentExecutorProfile -ErrorAction Stop
            $nextStr = "$($nextExec.executor)/$($nextExec.variant)"
        }
        catch {
            $nextStr = "/"
        }
    }
    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║          VirtEngine Task Orchestrator                    ║" -ForegroundColor Cyan
    Write-Host "  ║                                                         ║" -ForegroundColor Cyan
    Write-Host "  ║   Parallel: $($MaxParallel.ToString().PadRight(4))  Poll: ${PollIntervalSec}s  $(if($DryRun){'DRY-RUN'}else{'LIVE'})                ║" -ForegroundColor Cyan
    Write-Host "  ║   Cycling:  CODEX ⇄ COPILOT (50/50)                    ║" -ForegroundColor Cyan
    Write-Host "  ║   Next:     $($nextStr.PadRight(44))║" -ForegroundColor Cyan
    Write-Host "  ╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Ensure-GitIdentity {
    <#
    .SYNOPSIS Ensure git author/committer identity is set when env overrides are provided.
    #>
    $name = Get-EnvFallback -Name "VE_GIT_AUTHOR_NAME"
    if (-not $name) { $name = Get-EnvFallback -Name "GIT_AUTHOR_NAME" }
    $email = Get-EnvFallback -Name "VE_GIT_AUTHOR_EMAIL"
    if (-not $email) { $email = Get-EnvFallback -Name "GIT_AUTHOR_EMAIL" }

    if ($name) {
        try { git config user.name $name | Out-Null } catch { }
        Set-EnvValue -Name "GIT_AUTHOR_NAME" -Value $name
        Set-EnvValue -Name "GIT_COMMITTER_NAME" -Value $name
    }
    if ($email) {
        try { git config user.email $email | Out-Null } catch { }
        Set-EnvValue -Name "GIT_AUTHOR_EMAIL" -Value $email
        Set-EnvValue -Name "GIT_COMMITTER_EMAIL" -Value $email
    }
    if ($name -or $email) {
        Write-Log "Git identity configured from VE_GIT_AUTHOR_*" -Level "INFO"
    }
}

function Ensure-GitCredentialHelper {
    <#
    .SYNOPSIS Remove stale local credential helpers injected by VK workspace agents.
              VK containers may run 'gh auth setup-git' which writes the container's
              gh path (e.g., /home/jon/bin/gh.exe) into .git/config.  This breaks
              pushes from the host or other environments.  The global ~/.gitconfig
              already has the correct credential helper, so the local override is
              unnecessary and harmful.
    #>
    try {
        $localHelper = git config --local credential.helper 2>$null
        if ($localHelper -and ($localHelper -match '/home/.*/gh(\.exe)?|/tmp/.*/gh')) {
            Write-Log "Removing stale local credential.helper: $localHelper" -Level "WARN"
            git config --local --unset credential.helper 2>$null
        }
    }
    catch {
        # Non-fatal — if we can't check, push will fail with a clear error anyway
    }
}

function Write-CycleSummary {
    $elapsed = (Get-Date) - $script:StartTime
    $backlogCount = $null
    try {
        $todoTasks = Get-VKTasks -Status "todo" -Limit 1
        $backlogCount = if ($todoTasks) { @($todoTasks).Count } else { 0 }
    }
    catch {
        $backlogCount = $null
    }
    Write-Host ""
    Write-Host "  ── Cycle $($script:CycleCount) ──────────────────────────────" -ForegroundColor DarkCyan
    Write-Host "  │ Elapsed:   $([math]::Round($elapsed.TotalMinutes, 1)) min" -ForegroundColor DarkGray
    Write-Host "  │ Submitted: $($script:TasksSubmitted)  Completed: $($script:TasksCompleted)" -ForegroundColor DarkGray
    Write-Host "  │ Tracked:   $($script:TrackedAttempts.Count) attempts" -ForegroundColor DarkGray
    $successSummary = Get-SuccessRateSummary
    Write-Host "  │ $successSummary" -ForegroundColor DarkGray
    if ($null -ne $backlogCount) {
        Write-Host "  │ Backlog:   $backlogCount" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  │ Backlog:   unknown" -ForegroundColor DarkGray
    }
    Write-Host "  └────────────────────────────────────────────" -ForegroundColor DarkCyan
}

function Format-ShortId {
    param([string]$Value, [int]$Length = 8)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    if ($Value.Length -le $Length) { return $Value }
    return $Value.Substring(0, $Length)
}

function Invoke-GhWithTimeout {
    <#
    .SYNOPSIS Run gh CLI with a hard timeout to avoid hung PR creation.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Args,
        [int]$TimeoutSec = 120
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "gh"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.Environment["GH_PROMPT_DISABLED"] = "1"
    $psi.Environment["GIT_TERMINAL_PROMPT"] = "0"

    if ($psi.PSObject.Properties.Name -contains "ArgumentList") {
        foreach ($arg in $Args) {
            $null = $psi.ArgumentList.Add($arg)
        }
    }
    else {
        $escaped = $Args | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }
        $psi.Arguments = ($escaped -join ' ')
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $null = $proc.Start()

    $timedOut = -not $proc.WaitForExit([Math]::Max(1, $TimeoutSec) * 1000)
    if ($timedOut) {
        try { $proc.Kill($true) } catch { try { $proc.Kill() } catch { } }
        return @{
            timed_out = $true
            exit_code = $null
            output    = ""
            error     = "timeout"
        }
    }

    $output = $proc.StandardOutput.ReadToEnd()
    $error = $proc.StandardError.ReadToEnd()
    return @{
        timed_out = $false
        exit_code = $proc.ExitCode
        output    = $output
        error     = $error
    }
}

function Test-BranchMergedIntoBase {
    <#
    .SYNOPSIS Check if a branch's work was already merged into the base branch.
    .DESCRIPTION Uses GitHub CLI to check for merged PRs with this head branch,
                 then falls back to git merge-base --is-ancestor if local refs exist.
                 This catches the case where a task was completed, merged, and the
                 remote branch was deleted — preventing infinite retry loops.
    .PARAMETER Branch The branch name to check (e.g. "ve/359f-docs-portal-adr")
    .PARAMETER BaseBranch The base branch to check against (default: $script:VK_TARGET_BRANCH)
    .OUTPUTS Boolean — $true if the branch was definitively merged into base
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Branch,
        [string]$BaseBranch = $script:VK_TARGET_BRANCH
    )

    # Strategy 1: Check GitHub for a merged PR with this head branch (most reliable)
    try {
        $ghResult = gh pr list --head $Branch --state merged --json number, mergedAt --limit 1 2>$null
        if ($LASTEXITCODE -eq 0 -and $ghResult) {
            $mergedPRs = $ghResult | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($mergedPRs -and @($mergedPRs).Count -gt 0) {
                $prNum = $mergedPRs[0].number
                Write-Log "Branch $Branch has merged PR #$prNum on GitHub — already completed" -Level "OK"
                return $true
            }
        }
    }
    catch {
        # gh CLI not available or rate-limited — fall through to git check
    }

    # Strategy 2: Check if local branch tip is an ancestor of base (works if refs exist)
    try {
        $branchRef = $Branch
        $baseRef = if ($BaseBranch -like "origin/*") { $BaseBranch } else { "origin/$BaseBranch" }

        # Check if the branch ref exists locally
        git rev-parse --verify --quiet $branchRef 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }

        git merge-base --is-ancestor $branchRef $baseRef 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Branch $Branch is ancestor of $baseRef — already merged" -Level "OK"
            return $true
        }
    }
    catch {
        # Git check failed — not conclusive
    }

    return $false
}

function Test-TaskDescriptionAlreadyComplete {
    <#
    .SYNOPSIS Check if a task's description indicates it's already completed/superseded.
    .DESCRIPTION Looks for common patterns in task descriptions that indicate the work
                 is already done. Used to skip tasks that were completed in a previous
                 session but still have active (non-archived) attempts.
    .PARAMETER TaskId The VK task ID to check
    .OUTPUTS Boolean — $true if the task description indicates it's already done
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskId
    )
    try {
        $task = Get-VKTask -TaskId $TaskId -ErrorAction SilentlyContinue
        if (-not $task -or -not $task.description) { return $false }
        $desc = $task.description.ToLower()
        $completionPatterns = @(
            "superseded by",
            "already completed",
            "this task has been completed",
            "merged in",
            "completed via",
            "no longer needed",
            "has been completed via",
            "already merged"
        )
        foreach ($pattern in $completionPatterns) {
            if ($desc -match [regex]::Escape($pattern)) {
                Write-Log "Task $($TaskId.Substring(0,8)) description indicates already completed ('$pattern')" -Level "INFO"
                return $true
            }
        }
    }
    catch {
        # Best effort — don't block on API errors
    }
    return $false
}

function Get-CommitsAhead {
    <#
    .SYNOPSIS Check how many commits a branch has compared to base branch.
    .DESCRIPTION Returns the number of commits the branch has that base doesn't have.
    .PARAMETER Branch The branch to check
    .PARAMETER BaseBranch The base branch to compare against (default: $script:VK_TARGET_BRANCH)
    .OUTPUTS Integer count of commits ahead, or -1 if branch doesn't exist
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Branch,
        [string]$BaseBranch = $script:VK_TARGET_BRANCH
    )

    # Ensure base branch format is correct (no origin/ prefix for rev-list)
    $baseRef = $BaseBranch
    if ($baseRef -like "origin/*") {
        $baseRef = $baseRef  # Keep origin/ for rev-list
    }

    # Check if branch exists
    $branchExists = git rev-parse --verify --quiet $Branch 2>$null
    if ($LASTEXITCODE -ne 0) {
        return -1
    }

    # Count commits ahead
    $commitsAhead = git rev-list --count "${baseRef}..${Branch}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Failed to count commits for ${Branch} vs ${baseRef}" -Level "WARN"
        return -1
    }

    return [int]$commitsAhead
}

function Create-PRForBranchSafe {
    <#
    .SYNOPSIS Create a PR for a branch with timeout + non-interactive guardrails.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Branch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Body = "Automated PR created by ve-orchestrator"
    )
    $baseBranch = $script:VK_TARGET_BRANCH
    if ($baseBranch -like "origin/*") { $baseBranch = $baseBranch.Substring(7) }

    $result = Invoke-GhWithTimeout -Args @(
        "pr", "create", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--head", $Branch,
        "--base", $baseBranch,
        "--title", $Title,
        "--body", $Body
    ) -TimeoutSec $GitHubCommandTimeoutSec

    if ($result.timed_out) {
        if (Get-Command Set-VKLastGithubError -ErrorAction SilentlyContinue) {
            Set-VKLastGithubError -Type "timeout" -Message "gh pr create timed out after ${GitHubCommandTimeoutSec}s"
        }
        Write-Log "gh pr create timed out after ${GitHubCommandTimeoutSec}s for $Branch" -Level "WARN"
        return $false
    }

    $combined = ($result.output + "`n" + $result.error).Trim()
    if ($result.exit_code -ne 0) {
        if ($combined -match "rate limit|API rate limit exceeded|secondary rate limit|abuse detection") {
            if (Get-Command Set-VKLastGithubError -ErrorAction SilentlyContinue) {
                Set-VKLastGithubError -Type "rate_limit" -Message $combined
            }
        }
        else {
            if (Get-Command Set-VKLastGithubError -ErrorAction SilentlyContinue) {
                Set-VKLastGithubError -Type "error" -Message $combined
            }
        }

        if ($combined -match "pull request already exists|already exists") {
            if (Get-Command Clear-VKLastGithubError -ErrorAction SilentlyContinue) {
                Clear-VKLastGithubError
            }
            return $true
        }

        # Non-retryable: branch has no commits vs base — stop looping
        if ($combined -match "No commits between|no difference|nothing to compare") {
            Write-Log "gh pr create failed for ${Branch}: branch has no commits vs base — marking no_commits" -Level "WARN"
            return "no_commits"
        }

        Write-Log "gh pr create failed for ${Branch}: $combined" -Level "WARN"
        return $false
    }

    if (Get-Command Clear-VKLastGithubError -ErrorAction SilentlyContinue) {
        Clear-VKLastGithubError
    }
    return $true
}

function Test-VKApiReachable {
    <#
    .SYNOPSIS Fast health check for the vibe-kanban API to avoid blocking init.
    #>
    [CmdletBinding()]
    param([int]$TimeoutSec = 5)

    $baseUrl = Get-VKBaseUrl
    $timeout = if ($TimeoutSec -gt 0) { $TimeoutSec } else { 5 }
    $client = $null
    try {
        $handler = New-Object System.Net.Http.HttpClientHandler
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($timeout)
        $resp = $client.GetAsync("$baseUrl/api/projects").GetAwaiter().GetResult()
        return $resp.IsSuccessStatusCode
    }
    catch {
        return $false
    }
    finally {
        if ($client) { $client.Dispose() }
    }
}

function Get-VKBaseUrl {
    if ($script:VK_BASE_URL) { return $script:VK_BASE_URL }
    $envBase = Get-EnvFallback -Name "VK_BASE_URL"
    if ($envBase) { return $envBase }
    return "http://127.0.0.1:54089"
}

function Get-OrchestratorState {
    if (-not (Test-Path $script:StatePath)) {
        return @{
            last_sequence_value     = $null
            last_task_id            = $null
            last_submitted_at       = $null
            last_ci_sweep_completed = 0
            last_ci_sweep_at        = $null
            total_tasks_completed   = 0
            vk_project_id           = $null
            vk_repo_id              = $null
        }
    }
    try {
        $raw = Get-Content -Path $script:StatePath -Raw
        if (-not $raw) {
            return @{
                last_sequence_value     = $null
                last_task_id            = $null
                last_submitted_at       = $null
                last_ci_sweep_completed = 0
                last_ci_sweep_at        = $null
                total_tasks_completed   = 0
                vk_project_id           = $null
                vk_repo_id              = $null
            }
        }
        $state = $raw | ConvertFrom-Json -Depth 5
        $lastSweep = if ($state.last_ci_sweep_completed) { [int]$state.last_ci_sweep_completed } else { 0 }
        $totalCompleted = if ($state.total_tasks_completed) { [int]$state.total_tasks_completed } else { 0 }
        return @{
            last_sequence_value     = $state.last_sequence_value
            last_task_id            = $state.last_task_id
            last_submitted_at       = $state.last_submitted_at
            last_ci_sweep_completed = $lastSweep
            last_ci_sweep_at        = $state.last_ci_sweep_at
            total_tasks_completed   = $totalCompleted
            vk_project_id           = $state.vk_project_id
            vk_repo_id              = $state.vk_repo_id
        }
    }
    catch {
        return @{
            last_sequence_value     = $null
            last_task_id            = $null
            last_submitted_at       = $null
            last_ci_sweep_completed = 0
            last_ci_sweep_at        = $null
            total_tasks_completed   = 0
            vk_project_id           = $null
            vk_repo_id              = $null
        }
    }
}

function Save-OrchestratorState {
    param(
        [Parameter(Mandatory)][hashtable]$State
    )
    $dir = Split-Path -Parent $script:StatePath
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $State | ConvertTo-Json -Depth 5 | Set-Content -Path $script:StatePath -Encoding UTF8
}

function Initialize-CISweepConfig {
    $script:CiSweepEvery = Get-EnvInt -Name "VE_CI_SWEEP_EVERY" -Default 15 -Min 0
    $script:CiSweepPrBackupEnabled = Get-EnvBool -Name "VE_CI_SWEEP_PR_BACKUP" -Default $true
    $script:CiSweepPrEvery = Get-EnvInt -Name "VE_CI_SWEEP_PR_EVERY" -Default $script:CiSweepEvery -Min 0
    $script:CopilotCloudCooldownMin = Get-EnvInt -Name "COPILOT_CLOUD_COOLDOWN_MIN" -Default 60 -Min 1
    $script:CopilotRateLimitCooldownMin = Get-EnvInt -Name "COPILOT_RATE_LIMIT_COOLDOWN_MIN" -Default 120 -Min 30
    $script:CopilotCloudDisableOnRateLimit = Get-EnvBool -Name "COPILOT_CLOUD_DISABLE_ON_RATE_LIMIT" -Default $true
    $envCopilotLocalResolution = Get-EnvFallback -Name "COPILOT_LOCAL_RESOLUTION"
    $script:CopilotLocalResolution = if ($envCopilotLocalResolution) { $envCopilotLocalResolution } else { "agent" }
    $script:OpenFleetTaskUpstream = Get-EnvString -Name "OPENFLEET_TASK_UPSTREAM" -Default "origin/ve/openfleet-generic"

    # Branch routing scope map (v0.8) — maps conventional commit scopes to upstream branches
    $script:BranchRoutingScopeMap = @{}
    $script:AutoRebaseOnMerge = Get-EnvBool -Name "AUTO_REBASE_ON_MERGE" -Default $true
    $envScopeMap = Get-EnvFallback -Name "BRANCH_ROUTING_SCOPE_MAP"
    if ($envScopeMap) {
        foreach ($pair in $envScopeMap.Split(",", [System.StringSplitOptions]::RemoveEmptyEntries)) {
            $parts = $pair.Split(":", 2)
            if ($parts.Count -eq 2 -and $parts[0].Trim() -and $parts[1].Trim()) {
                $script:BranchRoutingScopeMap[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim()
            }
        }
        Write-Log "Loaded $($script:BranchRoutingScopeMap.Count) branch routing scope entries from env" -Level "INFO"
    }
}

function Initialize-CISweepState {
    $state = Get-OrchestratorState
    $script:TotalTasksCompleted = [int]($state.total_tasks_completed ?? 0)
    if ($state.last_ci_sweep_completed -and $state.last_ci_sweep_completed -gt $script:TotalTasksCompleted) {
        $script:TotalTasksCompleted = [int]$state.last_ci_sweep_completed
    }
    $script:LastCISweepAt = $state.last_ci_sweep_at
}

function Update-CISweepState {
    param(
        [int]$TotalTasksCompleted,
        [string]$LastSweepAt,
        [int]$LastSweepCompleted
    )
    $state = Get-OrchestratorState
    if ($PSBoundParameters.ContainsKey("TotalTasksCompleted")) {
        $state.total_tasks_completed = $TotalTasksCompleted
    }
    if ($PSBoundParameters.ContainsKey("LastSweepAt")) {
        $state.last_ci_sweep_at = $LastSweepAt
    }
    if ($PSBoundParameters.ContainsKey("LastSweepCompleted")) {
        $state.last_ci_sweep_completed = $LastSweepCompleted
    }
    Save-OrchestratorState -State $state
}

function Apply-CachedVKConfig {
    $state = Get-OrchestratorState
    $cachedProjectId = $state.vk_project_id
    $cachedRepoId = $state.vk_repo_id
    $applied = $false

    if (-not $script:VK_PROJECT_ID -and $cachedProjectId) {
        $script:VK_PROJECT_ID = $cachedProjectId
        Set-EnvValue -Name "VK_PROJECT_ID" -Value $cachedProjectId
        $applied = $true
        Write-Log "Using cached VK project ID $($cachedProjectId.Substring(0,8))..." -Level "INFO"
    }

    if (-not $script:VK_REPO_ID -and $cachedRepoId) {
        $script:VK_REPO_ID = $cachedRepoId
        Set-EnvValue -Name "VK_REPO_ID" -Value $cachedRepoId
        $applied = $true
        Write-Log "Using cached VK repo ID $($cachedRepoId.Substring(0,8))..." -Level "INFO"
    }

    return $applied
}

function Save-VKConfigCache {
    $projectId = $script:VK_PROJECT_ID
    $repoId = $script:VK_REPO_ID
    if (-not $projectId -and -not $repoId) { return }

    $state = Get-OrchestratorState
    $updated = $false
    if ($projectId -and $state.vk_project_id -ne $projectId) {
        $state.vk_project_id = $projectId
        $updated = $true
    }
    if ($repoId -and $state.vk_repo_id -ne $repoId) {
        $state.vk_repo_id = $repoId
        $updated = $true
    }
    if ($updated) {
        Save-OrchestratorState -State $state
    }
}

function Get-CopilotState {
    if (-not (Test-Path $script:CopilotStatePath)) {
        return @{
            prs                   = @{}
            cloud_disabled_until  = $null
            cloud_disabled_reason = $null
            cloud_disabled_at     = $null
        }
    }
    try {
        $raw = Get-Content -Path $script:CopilotStatePath -Raw
        if (-not $raw) {
            return @{
                prs                   = @{}
                cloud_disabled_until  = $null
                cloud_disabled_reason = $null
                cloud_disabled_at     = $null
            }
        }
        $state = $raw | ConvertFrom-Json -Depth 6
        if (-not $state.prs) { $state | Add-Member -NotePropertyName prs -NotePropertyValue @{} -Force }
        if (-not ($state.prs -is [hashtable])) {
            $prs = @{}
            foreach ($prop in $state.prs.PSObject.Properties) {
                $prs[$prop.Name] = $prop.Value
            }
            $state.prs = $prs
        }
        return $state
    }
    catch {
        return @{
            prs                   = @{}
            cloud_disabled_until  = $null
            cloud_disabled_reason = $null
            cloud_disabled_at     = $null
        }
    }
}

function Save-CopilotState {
    param(
        [Parameter(Mandatory)][object]$State
    )
    if ($State -is [pscustomobject]) {
        $State = $State | ConvertTo-Json -Depth 6 | ConvertFrom-Json -AsHashtable
    }
    $dir = Split-Path -Parent $script:CopilotStatePath
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $State | ConvertTo-Json -Depth 6 | Set-Content -Path $script:CopilotStatePath -Encoding UTF8
}

function Get-CopilotPRState {
    param([Parameter(Mandatory)][int]$PRNumber)
    $state = Get-CopilotState
    $key = $PRNumber.ToString()
    if ($state.prs.ContainsKey($key)) { return $state.prs[$key] }
    return $null
}

function Set-CopilotPRState {
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [Parameter(Mandatory)][hashtable]$Value
    )
    $state = Get-CopilotState
    if (-not ($state.prs -is [hashtable])) {
        $state.prs = @{}
    }
    $key = $PRNumber.ToString()
    $state.prs[$key] = $Value
    Save-CopilotState -State $state
}

function Remove-CopilotPRState {
    param([Parameter(Mandatory)][int]$PRNumber)
    $state = Get-CopilotState
    if (-not ($state.prs -is [hashtable])) {
        $state.prs = @{}
    }
    $key = $PRNumber.ToString()
    if ($state.prs.ContainsKey($key)) {
        $state.prs.Remove($key)
        Save-CopilotState -State $state
    }
}

function Upsert-CopilotPRState {
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [Parameter(Mandatory)][hashtable]$Update
    )
    $state = Get-CopilotState
    if (-not ($state.prs -is [hashtable])) {
        $state.prs = @{}
    }
    $key = $PRNumber.ToString()
    $existing = $null
    if ($state.prs.ContainsKey($key)) {
        $existing = $state.prs[$key]
    }
    $requestedAt = if ($existing -and $existing.requested_at) { $existing.requested_at } else { $Update.requested_at }
    $mergedAt = if ($Update.merged_at) { $Update.merged_at } else { $existing.merged_at }
    $state.prs[$key] = @{
        requested_at = $requestedAt
        completed    = $Update.completed
        copilot_pr   = $Update.copilot_pr
        merged_at    = $mergedAt
    }
    Save-CopilotState -State $state
}

function Get-CopilotCloudDisabledUntil {
    $state = Get-CopilotState
    $untilRaw = $state.cloud_disabled_until
    if (-not $untilRaw) { return $null }
    try {
        return ([datetimeoffset]::Parse($untilRaw)).ToLocalTime().DateTime
    }
    catch {
        return $null
    }
}

function Clear-CopilotCloudDisabled {
    $state = Get-CopilotState
    $state.cloud_disabled_until = $null
    $state.cloud_disabled_reason = $null
    $state.cloud_disabled_at = $null
    Save-CopilotState -State $state
    # Only clear the _UNTIL cooldown — never clear COPILOT_CLOUD_DISABLED itself.
    # The user may have set COPILOT_CLOUD_DISABLED=1 permanently in .env;
    # wiping it here would override their intent when a cooldown expires.
    Set-EnvValue -Name "COPILOT_CLOUD_DISABLED_UNTIL" -Value ""
}

function Test-CopilotCloudDisabled {
    $flag = Get-EnvFallback -Name "COPILOT_CLOUD_DISABLED"
    if ($flag -and $flag.ToString().ToLower() -in @("1", "true", "yes")) {
        return $true
    }
    $until = $null
    $untilRaw = Get-EnvFallback -Name "COPILOT_CLOUD_DISABLED_UNTIL"
    if ($untilRaw) {
        try {
            $until = ([datetimeoffset]::Parse($untilRaw)).ToLocalTime().DateTime
        }
        catch {
            $until = $null
        }
    }
    if (-not $until) {
        $until = Get-CopilotCloudDisabledUntil
    }
    if (-not $until) { return $false }
    if ((Get-Date) -lt $until) { return $true }
    Clear-CopilotCloudDisabled
    return $false
}

function Disable-CopilotCloud {
    [CmdletBinding()]
    param(
        [string]$Reason,
        [int]$Minutes = 0
    )
    $duration = if ($Minutes -gt 0) { $Minutes } else { $script:CopilotCloudCooldownMin }
    $until = (Get-Date).AddMinutes($duration)
    $state = Get-CopilotState
    $state.cloud_disabled_until = $until.ToString("o")
    $state.cloud_disabled_reason = $Reason
    $state.cloud_disabled_at = (Get-Date).ToString("o")
    Save-CopilotState -State $state
    # Only set _UNTIL — never touch COPILOT_CLOUD_DISABLED itself.
    # That flag is the user's permanent setting from .env and must not be
    # overwritten by runtime cooldowns (otherwise Clear would need to restore
    # the original value, and wiping it re-enables Copilot when it shouldn't be).
    Set-EnvValue -Name "COPILOT_CLOUD_DISABLED_UNTIL" -Value $until.ToString("o")
    Write-Log "Copilot cloud disabled until $($until.ToString("o"))" -Level "WARN"
    if ($Reason) {
        Write-Log "Copilot cloud disable reason: $Reason" -Level "WARN"
    }
}

function Apply-CopilotStateToInfo {
    param(
        [Parameter(Mandatory)][hashtable]$Info,
        [Parameter(Mandatory)][int]$PRNumber
    )
    $copilotState = Get-CopilotPRState -PRNumber $PRNumber
    if (-not $copilotState) { return $null }
    $Info.copilot_fix_requested = $true
    $Info.copilot_fix_pr_number = $copilotState.copilot_pr
    $Info.copilot_fix_merged = [bool]$copilotState.completed
    if ($copilotState.requested_at) {
        try { $Info.copilot_fix_requested_at = [datetime]::Parse($copilotState.requested_at) } catch { }
    }
    if ($copilotState.merged_at) {
        try { $Info.copilot_fix_merged_at = [datetime]::Parse($copilotState.merged_at) } catch { }
    }
    return $copilotState
}

function Get-ReferencedPRNumbers {
    param([string[]]$Texts)
    $refs = New-Object System.Collections.Generic.HashSet[int]
    if (-not $Texts) { return @() }
    $pattern = '(?i)(?:PR\s*#?\s*|#)(\d{1,6})'
    foreach ($text in $Texts) {
        if (-not $text) { continue }
        foreach ($match in [regex]::Matches($text, $pattern)) {
            $value = $match.Groups[1].Value
            if ($value) { [void]$refs.Add([int]$value) }
        }
    }
    return @($refs | ForEach-Object { $_ })
}

function Sync-CopilotPRState {
    <#
    .SYNOPSIS Seed Copilot state from existing open Copilot PRs.
    #>
    $openPrs = Get-OpenPullRequests -Limit 200
    if (Test-GithubRateLimit) { return }
    if (-not $openPrs -or @($openPrs).Count -eq 0) { return }

    foreach ($pr in $openPrs) {
        if (-not $pr.author -or -not (Test-IsCopilotAuthor -Author $pr.author)) { continue }
        $details = Get-PRDetails -PRNumber $pr.number
        if (Test-GithubRateLimit) { return }
        $refs = Get-ReferencedPRNumbers -Texts @(
            $pr.title,
            $details.body,
            $details.headRefName,
            $pr.headRefName
        )
        $isComplete = if ($pr.title -match '^\[WIP\]') { $false } else { $true }
        $requestedAt = if ($pr.createdAt) { $pr.createdAt } else { (Get-Date).ToString("o") }
        if (-not $refs -or @($refs).Count -eq 0) {
            if (-not (Get-CopilotPRState -PRNumber $pr.number)) {
                Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                    requested_at = $requestedAt
                    completed    = $isComplete
                    copilot_pr   = $pr.number
                    merged_at    = $null
                }
                Write-Log "Synced Copilot PR #$($pr.number) (no reference)" -Level "INFO"
            }
            continue
        }

        foreach ($ref in $refs) {
            if (Get-CopilotPRState -PRNumber $ref) { continue }
            Upsert-CopilotPRState -PRNumber $ref -Update @{
                requested_at = $requestedAt
                completed    = $isComplete
                copilot_pr   = $pr.number
                merged_at    = $null
            }
            Write-Log "Synced Copilot PR #$($pr.number) for PR #$ref" -Level "INFO"
        }
    }
}

function Get-TaskUrl {
    param([Parameter(Mandatory)][string]$TaskId)
    $template = Get-EnvFallback -Name "VK_TASK_URL_TEMPLATE"
    if ($template) {
        return $template.Replace("{taskId}", $TaskId).Replace("{projectId}", $script:VK_PROJECT_ID)
    }
    $base = Get-EnvFallback -Name "VK_BOARD_URL"
    if (-not $base) { $base = Get-EnvFallback -Name "VK_WEB_URL" }
    if (-not $base) { return $null }
    return "$base/tasks/$TaskId"
}

function Get-AttemptExecutorProfile {
    param([Parameter(Mandatory)][object]$Attempt)
    if (-not $Attempt) { return $null }

    $profile = $null
    if ($Attempt.executor_profile_id) {
        $profile = $Attempt.executor_profile_id
    }
    elseif ($Attempt.executor_profile) {
        $profile = $Attempt.executor_profile
    }

    if ($profile) {
        if ($profile -is [string]) {
            $parts = $profile -split "[:/]"
            if ($parts.Count -ge 2) {
                return @{ executor = $parts[0]; variant = $parts[1] }
            }
            return @{ executor = $profile }
        }

        $execName = $profile.executor ?? $profile.Executor ?? $profile.name ?? $profile.id
        $variant = $profile.variant ?? $profile.Variant ?? $profile.model ?? $profile.model_variant
        if ($execName -or $variant) {
            return @{ executor = $execName; variant = $variant }
        }
    }

    $attemptExec = $Attempt.executor ?? $Attempt.Executor
    $attemptVariant = $Attempt.executor_variant ?? $Attempt.variant ?? $Attempt.executorVariant
    if ($attemptExec -or $attemptVariant) {
        return @{ executor = $attemptExec; variant = $attemptVariant }
    }

    return $null
}

function Add-RecentItem {
    param(
        [Parameter(Mandatory)][hashtable]$Item,
        [Parameter(Mandatory)][string]$ListName,
        [int]$Limit = 200
    )
    $current = Get-Variable -Name $ListName -Scope Script -ValueOnly
    $updated = @($current + $Item)
    if ($updated.Count -gt $Limit) {
        $updated = $updated | Select-Object -Last $Limit
    }
    Set-Variable -Name $ListName -Scope Script -Value $updated
}

function Save-StatusSnapshot {
    $dir = Split-Path -Parent $script:StatusStatePath
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $capacityInfo = Get-AvailableSlotCapacity
    Update-SlotMetrics -Capacity $capacityInfo.capacity -ActiveCount $capacityInfo.active_count -ActiveWeight $capacityInfo.active_weight -WorkstationInfo $capacityInfo.workstation
    $slotMetrics = Get-SlotMetricsSnapshot
    $attempts = @{}
    foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
        $attemptId = $entry.Key
        $info = $entry.Value
        $attempts.$attemptId = @{
            task_id               = $info.task_id
            branch                = $info.branch
            pr_number             = $info.pr_number
            executor              = $info.executor
            executor_variant      = $info.executor_variant
            target_branch         = $info.target_branch
            status                = $info.status
            updated_at            = (Get-Date).ToString("o")
            last_process_status   = $info.last_process_status
            copilot_fix_requested = $info.copilot_fix_requested
            copilot_fix_pr_number = $info.copilot_fix_pr_number
            copilot_fix_merged    = $info.copilot_fix_merged
        }
    }
    $counts = Get-TrackedStatusCounts
    $reviewTasks = @($script:TrackedAttempts.GetEnumerator() | Where-Object { $_.Value.status -eq "review" } | ForEach-Object { $_.Value.task_id })
    $errorTasks = @($script:TrackedAttempts.GetEnumerator() | Where-Object { $_.Value.status -eq "error" } | ForEach-Object { $_.Value.task_id })
    $manualReviewTasks = @($script:TrackedAttempts.GetEnumerator() | Where-Object { $_.Value.status -eq "manual_review" } | ForEach-Object { $_.Value.task_id })
    $pauseState = Get-GlobalPauseState
    $todoTasks = Get-VKTasks -Status "todo"
    $backlogRemaining = if ($todoTasks) { @($todoTasks).Count } else { 0 }
    $snapshot = @{
        updated_at            = (Get-Date).ToString("o")
        global_pause          = @{
            paused      = [bool]($pauseState.paused)
            reason      = $pauseState.reason
            pause_until = $pauseState.pauseUntil
            updated_at  = $pauseState.updatedAt
            source      = $pauseState.source
        }
        counts                = $counts
        tasks_submitted       = $script:TasksSubmitted
        tasks_completed       = $script:TasksCompleted
        total_tasks_completed = $script:TotalTasksCompleted
        backlog_remaining     = $backlogRemaining
        completed_tasks       = $script:CompletedTasks
        submitted_tasks       = $script:SubmittedTasks
        followup_events       = $script:FollowUpEvents
        copilot_requests      = $script:CopilotRequests
        review_tasks          = $reviewTasks
        error_tasks           = $errorTasks
        manual_review_tasks   = $manualReviewTasks
        slot_metrics          = $slotMetrics
        attempts              = $attempts
        success_metrics       = @{
            first_shot_success = $script:FirstShotSuccess
            needed_fix         = $script:TasksNeededFix
            failed             = $script:TasksFailed
            first_shot_rate    = $(
                $t = $script:FirstShotSuccess + $script:TasksNeededFix + $script:TasksFailed
                if ($t -gt 0) { [math]::Round(($script:FirstShotSuccess / $t) * 100, 1) } else { 0 }
            )
        }
    }
    $snapshot | ConvertTo-Json -Depth 6 | Set-Content -Path $script:StatusStatePath -Encoding UTF8
}

function Get-SequenceValue {
    <#
    .SYNOPSIS Extract sequence value from a task title like 29A/30B (numeric * 100 + letter index).
    #>
    param([Parameter(Mandatory)][string]$Title)
    $match = [regex]::Match($Title, "\b(\d{2,3})([A-Z])\b")
    if (-not $match.Success) { return $null }
    $num = [int]$match.Groups[1].Value
    $letter = $match.Groups[2].Value
    $letterIndex = ([int][char]$letter) - ([int][char]'A') + 1
    return ($num * 100) + $letterIndex
}

function Normalize-TaskLabelList {
    param([object]$Labels)
    $result = @()
    if ($null -eq $Labels) { return $result }
    if ($Labels -is [string]) { return @($Labels) }
    if ($Labels -is [System.Collections.IEnumerable]) {
        foreach ($item in $Labels) {
            if ($null -eq $item) { continue }
            if ($item -is [string]) {
                $result += $item
            }
            elseif ($item.name) {
                $result += $item.name
            }
            elseif ($item.label) {
                $result += $item.label
            }
            elseif ($item.title) {
                $result += $item.title
            }
        }
    }
    return $result
}

function Get-TaskTextBlob {
    param([Parameter(Mandatory)][object]$Task)
    $parts = @()
    foreach ($field in @("title", "name", "description", "body", "details", "content")) {
        $value = $Task.$field
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $parts += $value
    }
    $labels = @()
    foreach ($field in @("labels", "label", "tags", "tag", "categories", "category")) {
        $labels += Normalize-TaskLabelList -Labels $Task.$field
    }
    if ($Task.metadata) {
        $labels += Normalize-TaskLabelList -Labels $Task.metadata.labels
        $labels += Normalize-TaskLabelList -Labels $Task.metadata.tags
    }
    if ($labels.Count -gt 0) {
        $parts += ($labels -join " ")
    }
    return ($parts -join "`n")
}

function Normalize-BranchName {
    param([string]$Branch)
    if ([string]::IsNullOrWhiteSpace($Branch)) { return $null }
    return $Branch.Trim()
}

function Extract-UpstreamFromText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $match = [regex]::Match($Text, "\b(?:upstream|base|target)(?:_branch| branch)?\s*[:=]\s*([A-Za-z0-9._/-]+)", "IgnoreCase")
    if (-not $match.Success) { return $null }
    return Normalize-BranchName -Branch $match.Groups[1].Value
}

function Test-IsOpenFleetTask {
    param([Parameter(Mandatory)][object]$Task)
    $text = (Get-TaskTextBlob -Task $Task).ToLowerInvariant()
    if ($text -match "openfleet|OpenFleet|@virtengine/openfleet|scripts/openfleet") { return $true }
    return $false
}

function Extract-ScopeFromTitle {
    <#
    .SYNOPSIS Extract conventional commit scope from task title.
    .DESCRIPTION E.g. "feat(openfleet): add caching" → "openfleet"
                      "[P1] fix(veid): broken flow" → "veid"
    #>
    param([string]$Title)
    if (-not $Title) { return $null }
    $m = [regex]::Match($Title, '(?:^\[P\d+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)', "IgnoreCase")
    if ($m.Success) { return $m.Groups[1].Value.ToLowerInvariant().Trim() }
    return $null
}

function Resolve-BranchFromScopeMap {
    <#
    .SYNOPSIS Resolve upstream branch from config-based scope map.
    .DESCRIPTION Checks $script:BranchRoutingScopeMap for a matching scope.
    #>
    param([Parameter(Mandatory)][object]$Task)
    if (-not $script:BranchRoutingScopeMap -or $script:BranchRoutingScopeMap.Count -eq 0) { return $null }

    # 1. Title scope exact match
    $scope = Extract-ScopeFromTitle -Title ($Task.title ?? $Task.name)
    if ($scope -and $script:BranchRoutingScopeMap.ContainsKey($scope)) {
        return $script:BranchRoutingScopeMap[$scope]
    }

    # 2. Partial scope match
    if ($scope) {
        foreach ($key in $script:BranchRoutingScopeMap.Keys) {
            if ($scope.Contains($key) -or $key.Contains($scope)) {
                return $script:BranchRoutingScopeMap[$key]
            }
        }
    }

    # 3. Keyword match in task text
    $text = (Get-TaskTextBlob -Task $Task).ToLowerInvariant()
    foreach ($key in $script:BranchRoutingScopeMap.Keys) {
        if ($text.Contains($key.ToLowerInvariant())) {
            return $script:BranchRoutingScopeMap[$key]
        }
    }

    return $null
}

function Get-TaskUpstreamBranch {
    param([Parameter(Mandatory)][object]$Task)
    $fields = @(
        "target_branch",
        "base_branch",
        "upstream_branch",
        "upstream",
        "target",
        "base",
        "targetBranch",
        "baseBranch"
    )

    foreach ($field in $fields) {
        if ($Task.PSObject.Properties.Name -contains $field -and $Task.$field) {
            $value = Normalize-BranchName -Branch $Task.$field
            if ($value) { return $value }
        }
    }

    if ($Task.metadata) {
        foreach ($field in $fields) {
            if ($Task.metadata.PSObject.Properties.Name -contains $field -and $Task.metadata.$field) {
                $value = Normalize-BranchName -Branch $Task.metadata.$field
                if ($value) { return $value }
            }
        }
    }

    $labels = @()
    foreach ($field in @("labels", "label", "tags", "tag", "categories", "category")) {
        $labels += Normalize-TaskLabelList -Labels $Task.$field
    }
    if ($Task.metadata) {
        $labels += Normalize-TaskLabelList -Labels $Task.metadata.labels
        $labels += Normalize-TaskLabelList -Labels $Task.metadata.tags
    }
    foreach ($label in $labels) {
        if (-not $label) { continue }
        $match = [regex]::Match($label.ToString(), "^(?:upstream|base|target)(?:_branch)?[:=]\s*([A-Za-z0-9._/-]+)$", "IgnoreCase")
        if ($match.Success) {
            $value = Normalize-BranchName -Branch $match.Groups[1].Value
            if ($value) { return $value }
        }
    }

    $fromText = Extract-UpstreamFromText -Text (Get-TaskTextBlob -Task $Task)
    if ($fromText) { return $fromText }

    # Config-based scope routing (new in v0.8)
    $fromScope = Resolve-BranchFromScopeMap -Task $Task
    if ($fromScope) { return $fromScope }

    if (Test-IsOpenFleetTask -Task $Task) {
        return $script:OpenFleetTaskUpstream
    }

    return $script:VK_TARGET_BRANCH
}

function Get-TaskPriorityInfo {
    param([Parameter(Mandatory)][object]$Task)
    $rank = 2
    $label = "medium"

    $rawPriority = $null
    foreach ($field in @("priority", "priority_name", "priority_label", "priority_level", "priority_text")) {
        if ($Task.PSObject.Properties.Name -contains $field -and $Task.$field) {
            $rawPriority = $Task.$field
            break
        }
    }
    if (-not $rawPriority -and $Task.metadata) {
        foreach ($field in @("priority", "priority_name", "priority_label", "priority_level")) {
            if ($Task.metadata.PSObject.Properties.Name -contains $field -and $Task.metadata.$field) {
                $rawPriority = $Task.metadata.$field
                break
            }
        }
    }

    if ($rawPriority -is [int] -or $rawPriority -is [double]) {
        $num = [double]$rawPriority
        if ($num -le 0) { $rank = 0; $label = "critical" }
        elseif ($num -le 1) { $rank = 1; $label = "high" }
        elseif ($num -le 2) { $rank = 2; $label = "medium" }
        elseif ($num -le 3) { $rank = 3; $label = "low" }
        else { $rank = 4; $label = "backlog" }
        return @{ rank = $rank; label = $label }
    }

    $text = ""
    if ($rawPriority) { $text = $rawPriority.ToString() }
    if (-not $text) { $text = Get-TaskTextBlob -Task $Task }
    $text = $text.ToLowerInvariant()

    if ($text -match "\b(p0|critical|blocker|urgent|sev0)\b") {
        $rank = 0; $label = "critical"
    }
    elseif ($text -match "\b(p1|high|sev1)\b") {
        $rank = 1; $label = "high"
    }
    elseif ($text -match "\b(p2|medium|med|normal|sev2)\b") {
        $rank = 2; $label = "medium"
    }
    elseif ($text -match "\b(p3|low|sev3)\b") {
        $rank = 3; $label = "low"
    }
    elseif ($text -match "\b(backlog|icebox|later|nice-to-have)\b") {
        $rank = 4; $label = "backlog"
    }

    return @{ rank = $rank; label = $label }
}

function Resolve-TaskSizeFromPoints {
    param([double]$Points)
    if ($Points -le 1) { return @{ label = "xs"; weight = 0.75; points = $Points } }
    if ($Points -le 2) { return @{ label = "s"; weight = 1.0; points = $Points } }
    if ($Points -le 5) { return @{ label = "m"; weight = 1.5; points = $Points } }
    if ($Points -le 8) { return @{ label = "l"; weight = 2.0; points = $Points } }
    if ($Points -le 13) { return @{ label = "xl"; weight = 3.0; points = $Points } }
    return @{ label = "xxl"; weight = 4.0; points = $Points }
}

function Get-TaskSizeInfo {
    param([Parameter(Mandatory)][object]$Task)
    $sizeToken = $null
    $points = $null

    foreach ($field in @("size", "estimate", "story_points", "points", "effort", "complexity")) {
        if ($Task.PSObject.Properties.Name -contains $field -and $Task.$field) {
            $value = $Task.$field
            if ($value -is [int] -or $value -is [double]) {
                return Resolve-TaskSizeFromPoints -Points ([double]$value)
            }
            $sizeToken = $value.ToString()
            break
        }
    }

    if (-not $sizeToken -and $Task.metadata) {
        foreach ($field in @("size", "estimate", "story_points", "points", "effort")) {
            if ($Task.metadata.PSObject.Properties.Name -contains $field -and $Task.metadata.$field) {
                $value = $Task.metadata.$field
                if ($value -is [int] -or $value -is [double]) {
                    return Resolve-TaskSizeFromPoints -Points ([double]$value)
                }
                $sizeToken = $value.ToString()
                break
            }
        }
    }

    $text = Get-TaskTextBlob -Task $Task
    if ($text -match "(?i)\[(xs|s|m|l|xl|xxl|2xl)\]") {
        $sizeToken = $Matches[1]
    }
    elseif ($text -match "(?i)\b(size|effort|estimate|points|story\s*points)\s*[:=]\s*(\d+(\.\d+)?)\b") {
        $points = [double]$Matches[2]
    }
    elseif ($text -match "(?i)\b(size|effort|estimate|points|story\s*points)\s*[:=]\s*(xs|s|small|m|medium|l|large|xl|x-large|xxl|2xl)\b") {
        $sizeToken = $Matches[2]
    }

    if ($points -ne $null) {
        return Resolve-TaskSizeFromPoints -Points $points
    }

    if ($sizeToken) {
        $token = $sizeToken.ToString().ToLowerInvariant()
        switch -Regex ($token) {
            "xxl|2xl" { return @{ label = "xxl"; weight = 4.0; points = $null } }
            "xl|x-large" { return @{ label = "xl"; weight = 3.0; points = $null } }
            "l|large|big" { return @{ label = "l"; weight = 2.0; points = $null } }
            "m|medium|med" { return @{ label = "m"; weight = 1.5; points = $null } }
            "s|small" { return @{ label = "s"; weight = 1.0; points = $null } }
            "xs|tiny" { return @{ label = "xs"; weight = 0.75; points = $null } }
        }
    }

    return @{ label = "m"; weight = 1.0; points = $null }
}

# ─── Complexity Routing ───────────────────────────────────────────────────────

# Map task size labels to complexity tiers
$script:SizeToComplexity = @{
    "xs"  = "low"
    "s"   = "low"
    "m"   = "medium"
    "l"   = "high"
    "xl"  = "high"
    "xxl" = "high"
}

# Default model profiles per complexity tier and executor type
$script:ComplexityModels = @{
    "CODEX"   = @{
        "low"    = @{ model = "gpt-5.1-codex-mini"; variant = "GPT51_CODEX_MINI"; reasoningEffort = "low" }
        "medium" = @{ model = "gpt-5.2-codex"; variant = "DEFAULT"; reasoningEffort = "medium" }
        "high"   = @{ model = "gpt-5.2-codex"; variant = "DEFAULT"; reasoningEffort = "high" }
    }
    "COPILOT" = @{
        "low"    = @{ model = "haiku-4.5"; variant = "CLAUDE_HAIKU_4_5"; reasoningEffort = "low" }
        "medium" = @{ model = "sonnet-4.5"; variant = "CLAUDE_SONNET_4_5"; reasoningEffort = "medium" }
        "high"   = @{ model = "opus-4.6"; variant = "CLAUDE_OPUS_4_6"; reasoningEffort = "high" }
    }
}

# Keyword patterns that escalate complexity
$script:ComplexityEscalators = @(
    "\b(architect|redesign|refactor.*entire|overhaul|migration)\b",
    "\b(multi[- ]?module|cross[- ]?cutting|system[- ]?wide)\b",
    "\b(breaking\s+change|backward.*compat|api.*redesign)\b",
    "\b(security.*audit|vulnerability|encryption.*scheme|key.*rotation)\b",
    "\b(consensus|determinism|state.*machine|genesis|upgrade.*handler)\b",
    "\b(e2e.*test.*suite|integration.*framework|test.*infrastructure)\b",
    "\b(load\s+test|stress\s+test|1M|1,000,000|million\s+nodes?)\b",
    "\b(service\s+mesh|api\s+gateway|mTLS|circuit\s+breaker)\b",
    "Est\.?\s*LOC\s*:\s*[3-9],?\d{3}",
    "Est\.?\s*LOC\s*:\s*\d{2,},?\d{3}",
    "\b(\d{2,}\s+(?:test|file|module)s?\s+fail)",
    "\b(disaster\s+recovery|business\s+continuity|CRITICAL)\b"
)

# Keyword patterns that simplify complexity
$script:ComplexitySimplifiers = @(
    "\b(typo|typos|spelling|grammar)\b",
    "\b(bump|upgrade)\s+(version|dep|dependency)\b",
    "\b(readme|changelog|docs?\s+only)\b",
    "\b(lint|format|prettier|eslint)\s*(fix|cleanup|config)?\b",
    "\b(rename|move\s+file|copy\s+file)\b",
    "\b(add\s+comment|update\s+comment)\b",
    "\b(config\s+change|env\s+var|\.env)\b",
    "\bPlan\s+next\s+tasks\b",
    "\b(manual[- ]telegram|triage)\b"
)

function Resolve-ComplexityTier {
    <#
    .SYNOPSIS Map task size + text signals to a complexity tier (low/medium/high).
    .DESCRIPTION Mirrors task-complexity.mjs classifyComplexity() logic.
    #>
    param(
        [string]$SizeLabel = "m",
        [string]$Title = "",
        [string]$Description = ""
    )

    $tier = $script:SizeToComplexity[$SizeLabel.ToLowerInvariant()]
    if (-not $tier) { $tier = "medium" }

    $text = "$Title $Description".Trim()
    if (-not $text) {
        return @{ tier = $tier; adjusted = $false; reason = "size=$SizeLabel" }
    }

    $escalatorHits = 0
    $simplifierHits = 0
    foreach ($pattern in $script:ComplexityEscalators) {
        if ($text -match "(?i)$pattern") { $escalatorHits++ }
    }
    foreach ($pattern in $script:ComplexitySimplifiers) {
        if ($text -match "(?i)$pattern") { $simplifierHits++ }
    }

    $adjusted = $false
    $reason = "size=$SizeLabel"
    if ($escalatorHits -gt 0 -and $simplifierHits -eq 0) {
        if ($tier -eq "low") { $tier = "medium"; $adjusted = $true; $reason += " → escalated" }
        elseif ($tier -eq "medium") { $tier = "high"; $adjusted = $true; $reason += " → escalated" }
    }
    elseif ($simplifierHits -gt 0 -and $escalatorHits -eq 0) {
        if ($tier -eq "high") { $tier = "medium"; $adjusted = $true; $reason += " → simplified" }
        elseif ($tier -eq "medium") { $tier = "low"; $adjusted = $true; $reason += " → simplified" }
    }

    return @{ tier = $tier; adjusted = $adjusted; reason = $reason }
}

function Resolve-ExecutorForComplexity {
    <#
    .SYNOPSIS Select the right executor model/variant for a task based on its complexity.
    .DESCRIPTION Given a task and the base executor profile, returns an enhanced
    profile with the optimal model/variant/reasoningEffort for the task's complexity tier.
    .OUTPUTS Hashtable with: executor, variant, model, reasoningEffort, complexity
    #>
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][hashtable]$BaseProfile
    )

    $complexityEnabled = Get-EnvBool -Name "COMPLEXITY_ROUTING_ENABLED" -Default $true
    if (-not $complexityEnabled) {
        return $BaseProfile
    }

    $sizeInfo = Get-TaskSizeInfo -Task $Task
    $title = if ($Task.title) { $Task.title } else { "" }
    $description = if ($Task.description) { $Task.description } else { "" }

    $complexity = Resolve-ComplexityTier -SizeLabel $sizeInfo.label -Title $title -Description $description
    $executorType = if ($BaseProfile.executor) { $BaseProfile.executor.ToUpperInvariant() } else { "CODEX" }

    # Get model profile for this tier + executor type
    $models = $script:ComplexityModels[$executorType]
    if (-not $models) { $models = $script:ComplexityModels["CODEX"] }
    $modelProfile = $models[$complexity.tier]
    if (-not $modelProfile) { $modelProfile = $models["medium"] }

    # Check env overrides per tier
    $prefix = "COMPLEXITY_ROUTING_${executorType}_$($complexity.tier.ToUpperInvariant())"
    $envModel = Get-EnvFallback -Name ("{0}_MODEL" -f $prefix)
    $envVariant = Get-EnvFallback -Name ("{0}_VARIANT" -f $prefix)

    $result = @{
        name            = $BaseProfile.name
        executor        = $BaseProfile.executor
        variant         = if ($envVariant) { $envVariant } elseif ($modelProfile.variant) { $modelProfile.variant } else { $BaseProfile.variant }
        weight          = $BaseProfile.weight
        role            = $BaseProfile.role
        enabled         = $BaseProfile.enabled
        model           = if ($envModel) { $envModel } else { $modelProfile.model }
        reasoningEffort = $modelProfile.reasoningEffort
        complexity      = $complexity
    }

    Write-Log ("Complexity routing: {0} (size={1}, complexity={2}, model={3}, reasoning={4})" -f `
            $title.Substring(0, [Math]::Min(50, $title.Length)),
        $sizeInfo.label, $complexity.tier, $result.model, $result.reasoningEffort) -Level "INFO"

    return $result
}

function Get-WorkstationRegistryPath {
    $registryPath = Get-EnvFallback -Name "VE_WORKSPACE_REGISTRY_PATH"
    if ($registryPath) {
        return $registryPath
    }
    return (Join-Path $PSScriptRoot "workspaces.json")
}

function Get-WorkstationCapacity {
    $envCap = Get-EnvInt -Name "VE_WORKSTATION_CAPACITY" -Default 0 -Min 0
    if ($envCap -gt 0) { return $envCap }
    $envCap = Get-EnvInt -Name "VK_WORKSTATION_CAPACITY" -Default 0 -Min 0
    if ($envCap -gt 0) { return $envCap }
    $envCap = Get-EnvInt -Name "VK_WORKSTATIONS" -Default 0 -Min 0
    if ($envCap -gt 0) { return $envCap }

    $registryPath = Get-WorkstationRegistryPath
    if (-not (Test-Path -LiteralPath $registryPath)) { return 0 }
    try {
        $raw = Get-Content -LiteralPath $registryPath -Raw
        $registry = $raw | ConvertFrom-Json
        if ($registry.workspaces) {
            $count = @($registry.workspaces).Count
            if ($count -gt 0) { return $count }
        }
    }
    catch {
        return 0
    }
    return 0
}

function Get-WorkspaceStatusFromSummary {
    param([Parameter(Mandatory)][object]$Summary)
    foreach ($field in @("workspace_status", "status", "agent_status", "latest_process_status")) {
        if ($Summary.PSObject.Properties.Name -contains $field -and $Summary.$field) {
            return $Summary.$field.ToString().ToLowerInvariant()
        }
    }
    return ""
}

function Get-WorkstationAvailability {
    $capacity = Get-WorkstationCapacity
    $busy = 0
    $idle = 0

    foreach ($summary in $script:AttemptSummaries.Values) {
        $status = Get-WorkspaceStatusFromSummary -Summary $summary
        if (-not $status) { continue }
        if ($status -match "running|busy|working|active|in_progress|processing") {
            $busy++
        }
        elseif ($status -match "idle|ready|waiting|available|paused") {
            $idle++
        }
        else {
            $busy++
        }
    }

    $activeCount = Get-ActiveAgentCount
    if ($activeCount -gt $busy) { $busy = $activeCount }

    if ($capacity -le 0) { $capacity = $MaxParallel }
    $available = [math]::Max(0, $capacity - $busy)
    return @{
        capacity  = $capacity
        busy      = $busy
        available = $available
        idle      = $idle
    }
}

function Get-EffectiveParallelCapacity {
    $availability = Get-WorkstationAvailability
    # MaxParallel takes precedence when explicitly set — workstation count is
    # informational (for multi-machine setups) and should NOT cap a single
    # machine that can handle more concurrent agents.
    $capacity = $MaxParallel
    if ($capacity -le 0) { $capacity = $availability.capacity }
    if ($capacity -le 0) { $capacity = 2 }
    return @{
        capacity    = $capacity
        workstation = $availability
    }
}

function Get-ActiveSlotWeight {
    $total = 0.0
    foreach ($item in $script:TrackedAttempts.Values) {
        if ($item.status -ne "running") { continue }
        $weight = if ($item.task_size_weight) { [double]$item.task_size_weight } else { 1.0 }
        $total += $weight
    }
    return $total
}

function Get-AvailableSlotCapacity {
    $capacityInfo = Get-EffectiveParallelCapacity
    $capacity = [double]$capacityInfo.capacity
    $activeCount = Get-ActiveAgentCount
    $activeWeight = Get-ActiveSlotWeight
    # Use actual task count, not weight, for slot availability
    $remaining = [math]::Max(0.0, $capacity - $activeCount)
    return @{
        capacity      = $capacity
        active_count  = $activeCount
        active_weight = $activeWeight
        remaining     = $remaining
        workstation   = $capacityInfo.workstation
    }
}

function Update-SlotMetrics {
    param(
        [double]$Capacity,
        [int]$ActiveCount,
        [double]$ActiveWeight,
        [hashtable]$WorkstationInfo
    )
    $now = Get-Date
    if ($Capacity -le 0) {
        $script:SlotMetrics.last_sample_at = $now
        return
    }
    if ($script:SlotMetrics.last_sample_at) {
        $elapsed = ($now - $script:SlotMetrics.last_sample_at).TotalSeconds
        if ($elapsed -gt 0) {
            # Track idle slots based on actual count, not weight
            $idle = [math]::Max(0.0, $Capacity - $ActiveCount)
            $script:SlotMetrics.total_idle_seconds += ($idle * $elapsed)
            $script:SlotMetrics.total_capacity_seconds += ($Capacity * $elapsed)
        }
    }
    $script:SlotMetrics.last_sample_at = $now
    $idleNow = [math]::Max(0.0, $Capacity - $ActiveCount)
    $utilizationNow = if ($Capacity -gt 0) { [math]::Round(($ActiveCount / $Capacity) * 100, 1) } else { 0 }
    $cumulativeUtilization = if ($script:SlotMetrics.total_capacity_seconds -gt 0) {
        [math]::Round((1 - ($script:SlotMetrics.total_idle_seconds / $script:SlotMetrics.total_capacity_seconds)) * 100, 1)
    }
    else { 0 }
    $script:SlotMetrics.last_snapshot = @{
        sampled_at                 = $now.ToString("o")
        capacity_slots             = $Capacity
        active_slots               = $ActiveCount
        active_weight              = $ActiveWeight
        idle_slots                 = $idleNow
        utilization_percent        = $utilizationNow
        total_idle_seconds         = [math]::Round($script:SlotMetrics.total_idle_seconds, 1)
        total_capacity_seconds     = [math]::Round($script:SlotMetrics.total_capacity_seconds, 1)
        cumulative_utilization_pct = $cumulativeUtilization
        workstation_capacity       = $WorkstationInfo.capacity
        workstation_available      = $WorkstationInfo.available
        workstation_busy           = $WorkstationInfo.busy
    }
}

function Get-SlotMetricsSnapshot {
    if ($script:SlotMetrics.last_snapshot) {
        return $script:SlotMetrics.last_snapshot
    }
    return @{
        sampled_at                 = $null
        capacity_slots             = 0
        active_slots               = 0
        active_weight              = 0
        idle_slots                 = 0
        utilization_percent        = 0
        total_idle_seconds         = 0
        total_capacity_seconds     = 0
        cumulative_utilization_pct = 0
        workstation_capacity       = 0
        workstation_available      = 0
        workstation_busy           = 0
    }
}

function Get-OrderedTodoTasks {
    <#
    .SYNOPSIS Return todo tasks ordered by priority queues, then sequence number (e.g., 37A < 37B < 38A), then size/created_at.
    Sequence numbers in task titles (like "37A", "38D", "45B") drive execution order:
      - 37A (seq=3701) runs before 38A (seq=3801) which runs before 45B (seq=4502)
      - Within a priority group, tasks are sorted by sequence ascending
      - Tasks without sequence numbers are sorted by size (smallest first) then created_at
    #>
    [CmdletBinding()]
    param([int]$Count = 1)

    $tasks = Get-VKTasks -Status "todo"
    if (-not $tasks) { return @() }

    $taskInfos = @()
    foreach ($task in $tasks) {
        $priorityInfo = Get-TaskPriorityInfo -Task $task
        $sizeInfo = Get-TaskSizeInfo -Task $task
        $seqValue = if ($task.title) { Get-SequenceValue -Title $task.title } else { $null }
        $taskInfos += [pscustomobject]@{
            task           = $task
            priority_rank  = $priorityInfo.rank
            priority_label = $priorityInfo.label
            size_weight    = $sizeInfo.weight
            seq            = $seqValue
            created_at     = $task.created_at
        }
    }

    $state = Get-OrchestratorState
    $lastSeq = $state.last_sequence_value

    $ordered = [System.Collections.Generic.List[object]]::new()
    $priorityGroups = $taskInfos | Group-Object -Property priority_rank | Sort-Object -Property Name
    foreach ($group in $priorityGroups) {
        $seqTasks = @($group.Group | Where-Object { $_.seq })
        $otherTasks = @($group.Group | Where-Object { -not $_.seq })

        $seqTasks = @($seqTasks | Sort-Object -Property seq)
        if ($seqTasks.Count -gt 0) {
            if ($lastSeq) {
                $after = @($seqTasks | Where-Object { $_.seq -gt $lastSeq })
                $before = @($seqTasks | Where-Object { $_.seq -le $lastSeq })
                foreach ($item in $after) { $ordered.Add($item.task) }
                foreach ($item in $before) { $ordered.Add($item.task) }
            }
            else {
                foreach ($item in $seqTasks) { $ordered.Add($item.task) }
            }
        }

        if ($otherTasks.Count -gt 0) {
            $orderedOther = @($otherTasks | Sort-Object -Property @{
                    Expression = { $_.size_weight }
                    Ascending  = $true
                }, @{
                    Expression = { $_.created_at }
                    Ascending  = $true
                })
            foreach ($item in $orderedOther) { $ordered.Add($item.task) }
        }
    }

    return @($ordered | Select-Object -First $Count)
}

function Test-GithubCooldown {
    if ($script:GitHubCooldownUntil -and (Get-Date) -lt $script:GitHubCooldownUntil) {
        $remaining = [math]::Ceiling(($script:GitHubCooldownUntil - (Get-Date)).TotalSeconds)
        Write-Log "GitHub cooldown active ($remaining s remaining) — skipping GitHub calls" -Level "WARN"
        return $true
    }
    return $false
}

function Set-GithubCooldown {
    param([string]$Reason)
    $script:GitHubCooldownUntil = (Get-Date).AddSeconds($GitHubCooldownSec)
    Write-Log "GitHub rate limit detected — cooling down for ${GitHubCooldownSec}s" -Level "WARN"
    if ($Reason) {
        Write-Log "Reason: $Reason" -Level "WARN"
    }
}

function Test-GithubRateLimit {
    $err = Get-VKLastGithubError
    if ($err -and $err.type -eq "rate_limit") {
        Set-GithubCooldown -Reason $err.message
        return $true
    }
    return $false
}

function Get-AttemptLastActivity {
    <#
    .SYNOPSIS Estimate last activity time for an attempt using summary status.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Summary)

    if (-not $Summary) { return $null }
    if (-not $Summary.latest_process_completed_at) { return $null }
    try {
        return ([datetimeoffset]::Parse($Summary.latest_process_completed_at)).ToLocalTime().DateTime
    }
    catch {
        return $null
    }
}

function Get-TrackedStatusCounts {
    $counts = @{ running = 0; review = 0; error = 0; manual_review = 0; other = 0 }
    foreach ($item in $script:TrackedAttempts.Values) {
        switch ($item.status) {
            "running" { $counts.running++ }
            "review" { $counts.review++ }
            "error" { $counts.error++ }
            "manual_review" { $counts.manual_review++ }
            default { $counts.other++ }
        }
    }
    return $counts
}

function Clear-PendingFollowUp {
    param(
        [Parameter(Mandatory)][hashtable]$Info,
        [string]$Reason
    )
    if ($Info.pending_followup) {
        $Info.pending_followup = $null
        $Info.last_followup_reason = $Reason
    }
}

function Get-ActiveAgentCount {
    return @($script:TrackedAttempts.Values | Where-Object { $_.status -eq "running" }).Count
}

function Get-AvailableSlots {
    $capacityInfo = Get-AvailableSlotCapacity
    $remaining = $capacityInfo.remaining
    return [math]::Max(0, [int][math]::Floor($remaining))
}

function Update-TaskContextCache {
    param([Parameter(Mandatory)][hashtable]$Info)
    if (-not $Info.task_id) { return }
    $needsTitle = -not $Info.task_title_cached
    $needsDescription = -not $Info.task_description_cached
    $needsSize = -not $Info.task_size_cached
    $needsPriority = -not $Info.task_priority_cached
    if (-not $needsTitle -and -not $needsDescription -and -not $needsSize -and -not $needsPriority) { return }

    try {
        $task = Get-VKTask -TaskId $Info.task_id
    }
    catch {
        return
    }
    if (-not $task) { return }

    if ($needsTitle) {
        $Info.task_title_cached = if ($task.title) { $task.title } elseif ($task.name) { $task.name } else { $Info.name }
    }
    if ($needsDescription) {
        $Info.task_description_cached = if ($task.description) {
            $task.description
        }
        elseif ($task.body) {
            $task.body
        }
        elseif ($task.details) {
            $task.details
        }
        elseif ($task.content) {
            $task.content
        }
        else {
            $null
        }
    }
    if ($needsSize) {
        $sizeInfo = Get-TaskSizeInfo -Task $task
        $Info.task_size_cached = $sizeInfo.label
        $Info.task_size_weight = $sizeInfo.weight
    }
    if ($needsPriority) {
        $priorityInfo = Get-TaskPriorityInfo -Task $task
        $Info.task_priority_cached = $priorityInfo.label
        $Info.task_priority_rank = $priorityInfo.rank
    }
}

function Get-TaskContextBlock {
    param(
        [Parameter(Mandatory)][hashtable]$Info,
        [int]$MaxDescriptionChars = 0
    )
    Update-TaskContextCache -Info $Info

    $title = if ($Info.task_title_cached) { $Info.task_title_cached } elseif ($Info.name) { $Info.name } else { $null }
    $description = $Info.task_description_cached
    if (-not $description) {
        $description = "Task description unavailable from VK. Open the task URL for full details."
    }
    elseif ($MaxDescriptionChars -gt 0 -and $description.Length -gt $MaxDescriptionChars) {
        $description = ($description.Substring(0, $MaxDescriptionChars)).TrimEnd()
        $description = "$description`n...[truncated]"
    }

    $lines = @("Task context (vibe-kanban):")
    if ($Info.branch) { $lines += "Branch: $($Info.branch)" }
    if ($title) { $lines += "Title: $title" }
    $lines += "Description:`n$description"
    $taskUrl = if ($Info.task_id) { Get-TaskUrl -TaskId $Info.task_id } else { $null }
    if ($taskUrl) { $lines += "Task URL: $taskUrl" }
    $lines += "If VE_TASK_TITLE/VE_TASK_DESCRIPTION are missing, treat this as an orchestrated task:"
    $lines += "- Worktree paths often include .git/worktrees/ or a task runner path (e.g., vibe-kanban)."
    $lines += "- Tasks typically map to a ve/<id>-<slug> branch."
    $lines += ""
    $lines += "IMPORTANT: Your job is to COMPLETE the task described above END TO END."
    $lines += "Implement the code changes, ensure tests pass, then commit and push."
    $lines += "Do NOT just check git status or reply with status — do the actual work."
    return ($lines -join "`n")
}

function Append-TaskContextToMessage {
    param(
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][hashtable]$Info,
        [switch]$IncludeContext
    )
    if (-not $IncludeContext) { return $Message }
    if ($Message -match "Task context \\(vibe-kanban\\):") {
        if ($script:FollowUpMaxChars -and $Message.Length -gt $script:FollowUpMaxChars) {
            $trimmed = ($Message.Substring(0, $script:FollowUpMaxChars)).TrimEnd()
            return "$trimmed`n...[truncated]"
        }
        return $Message
    }
    $context = Get-TaskContextBlock -Info $Info
    if (-not $context) { return $Message }
    $final = "$Message`n`n$context"
    if ($script:FollowUpMaxChars -and $final.Length -gt $script:FollowUpMaxChars) {
        $compact = Get-TaskContextBlock -Info $Info -MaxDescriptionChars $script:FollowUpMaxDescriptionChars
        if ($compact) {
            $final = "$Message`n`n$compact"
        }
        if ($final.Length -gt $script:FollowUpMaxChars) {
            $final = ($final.Substring(0, $script:FollowUpMaxChars)).TrimEnd()
            $final = "$final`n...[truncated]"
        }
    }
    return $final
}

function Get-ContextRecoveryMessage {
    <#
    .SYNOPSIS Build a compact follow-up message for context window/token limit failures.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Info,
        [int]$MaxDescriptionChars = 2000
    )
    $parts = @(
        "Context window exceeded (prompt too large). Start a fresh session with minimal context.",
        "Re-open the repo and continue the task. Keep prompts concise; avoid large log dumps."
    )
    $context = Get-TaskContextBlock -Info $Info -MaxDescriptionChars $MaxDescriptionChars
    if ($context) { $parts += $context }
    return ($parts -join "`n`n")
}

function Get-ModelErrorRecoveryMessage {
    <#
    .SYNOPSIS Build a compact follow-up message for model/API failures.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Info,
        [int]$MaxDescriptionChars = 2000
    )
    $parts = @(
        "Model API failure detected. Start a fresh session with minimal context.",
        "Keep prompts concise and avoid large logs or dumps."
    )
    $context = Get-TaskContextBlock -Info $Info -MaxDescriptionChars $MaxDescriptionChars
    if ($context) { $parts += $context }
    return ($parts -join "`n`n")
}

function Try-ArchiveAttempt {
    <#
    .SYNOPSIS Safely archive an attempt, handling already-archived cases and HTTP errors gracefully.
    .DESCRIPTION
    Checks if attempt is already archived in VK before calling the archive API.
    Treats 404/405/409 HTTP errors as "already handled" (DEBUG level) instead of failures.
    .OUTPUTS $true if archived or already archived, $false if hard failure
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AttemptId,
        [object]$AttemptObject = $null  # Optional: pass the attempt object to check archived status
    )

    # Check if attempt is already archived (if we have the object)
    if ($AttemptObject -and $AttemptObject.archived) {
        Write-Log "Attempt $($AttemptId.Substring(0,8)) already archived in VK — skipping" -Level "DEBUG"
        return $true
    }

    $vkBaseUrl = Get-VKBaseUrl
    $archiveUrl = "$vkBaseUrl/api/task-attempts/$AttemptId/archive"

    try {
        Invoke-RestMethod -Uri $archiveUrl -Method POST -ContentType "application/json" -Body "{}" -ErrorAction Stop | Out-Null
        Write-Log "Archived attempt $($AttemptId.Substring(0,8))" -Level "OK"
        return $true
    }
    catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -in @(404, 405, 409)) {
            # 404 = not found (already deleted?), 405 = method not allowed (can't archive in current state), 409 = conflict (already archived)
            Write-Log "Attempt $($AttemptId.Substring(0,8)) cannot be archived (HTTP $statusCode) — likely already handled or in non-archivable state" -Level "DEBUG"
            return $true  # Treat as success (already handled)
        }
        else {
            Write-Log "Failed to archive attempt $($AttemptId.Substring(0,8)): $_" -Level "WARN"
            return $false
        }
    }
}

function Try-SendFollowUp {
    <#
    .SYNOPSIS Send a follow-up only when the agent is idle and slots are available.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AttemptId,
        [Parameter(Mandatory)][hashtable]$Info,
        [Parameter(Mandatory)][string]$Message,
        [string]$Reason,
        [switch]$IncludeTaskContext = $true
    )

    # ── Global follow-up cap: prevent infinite loops per task ──────────────
    $taskKey = if ($Info.task_id) { $Info.task_id } else { $AttemptId }
    if (-not $script:TaskFollowUpCounts.ContainsKey($taskKey)) {
        $script:TaskFollowUpCounts[$taskKey] = 0
    }
    $script:TaskFollowUpCounts[$taskKey]++
    $followUpCount = $script:TaskFollowUpCounts[$taskKey]
    if ($followUpCount -gt $script:MAX_FOLLOWUPS_PER_TASK) {
        Write-Log "Follow-up cap ($script:MAX_FOLLOWUPS_PER_TASK) exceeded for task $($taskKey.Substring(0,8)) ($followUpCount follow-ups) — marking manual_review" -Level "WARN"
        $Info.status = "manual_review"
        $Info.followup_cap_exceeded = $true
        $Info.pending_followup = $null
        $script:TasksFailed++
        Save-SuccessMetrics
        Try-ArchiveAttempt -AttemptId $AttemptId | Out-Null
        return $false
    }

    if ($Info.force_new_session) {
        return (Try-SendFollowUpNewSession -AttemptId $AttemptId -Info $Info -Message $Message -Reason $Reason -IncludeTaskContext:$IncludeTaskContext)
    }
    if ($Info.status -eq "running" -or $Info.last_process_status -eq "running") {
        Write-Log "Skipping follow-up for $($Info.branch): agent active" -Level "INFO"
        return $false
    }
    $finalMessage = Append-TaskContextToMessage -Message $Message -Info $Info -IncludeContext:$IncludeTaskContext
    $Info.last_followup_message = $finalMessage
    $Info.last_followup_reason = $Reason
    $Info.last_followup_at = Get-Date
    $slots = Get-AvailableSlots
    if ($slots -le 0) {
        Write-Log "Deferring follow-up for $($Info.branch): no available slots" -Level "WARN"
        $Info.pending_followup = @{ message = $finalMessage; reason = $Reason }
        return $false
    }
    if (-not $DryRun) {
        try {
            Send-VKWorkspaceFollowUp -WorkspaceId $AttemptId -Message $finalMessage | Out-Null
        }
        catch {
            Write-Log "Follow-up failed for $($Info.branch): $($_.Exception.Message)" -Level "WARN"
            $Info.pending_followup = @{ message = $finalMessage; reason = $Reason }
            return $false
        }
    }
    $Info.pending_followup = $null
    $Info.status = "running"
    $taskUrl = if ($Info.task_id) { Get-TaskUrl -TaskId $Info.task_id } else { $null }

    # ── Agent Work Logger: log followup ──
    if ($script:AgentWorkLoggerEnabled) {
        try {
            Write-AgentFollowup -AttemptId $AttemptId `
                -Message $finalMessage.Substring(0, [Math]::Min(500, $finalMessage.Length)) `
                -Reason $Reason
        }
        catch {
            # best effort — non-critical
        }
    }

    Add-RecentItem -ListName "FollowUpEvents" -Item @{
        task_id     = $Info.task_id
        task_title  = $Info.name
        attempt_id  = $AttemptId
        branch      = $Info.branch
        reason      = $Reason
        task_url    = $taskUrl
        occurred_at = (Get-Date).ToString("o")
    }
    return $true
}

function Get-PendingFollowUpAttempts {
    return @($script:TrackedAttempts.GetEnumerator() | Where-Object { $_.Value.pending_followup })
}

function Process-PendingFollowUps {
    <#
    .SYNOPSIS Send queued follow-ups before starting new tasks.
    #>
    $slots = Get-AvailableSlots
    if ($slots -le 0) { return }

    $pending = Get-PendingFollowUpAttempts
    if (-not $pending -or @($pending).Count -eq 0) { return }

    foreach ($entry in $pending) {
        if ($slots -le 0) { break }
        $attemptId = $entry.Key
        $info = $entry.Value
        $message = $info.pending_followup.message
        $reason = $info.pending_followup.reason
        $useNewSession = $info.pending_followup.new_session
        $sent = if ($useNewSession) {
            Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $message -Reason $reason
        }
        else {
            Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $message -Reason $reason
        }
        if ($sent) {
            $slots -= 1
        }
    }
}

function Test-ContextWindowError {
    <#
    .SYNOPSIS Detect context window errors from a summary payload.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Summary)
    $patterns = @(
        "ContextWindowExceeded",
        "context window",
        "ran out of room",
        "prompt token count",
        "token count of",
        "context length exceeded",
        "maximum context length",
        "exceeds the limit",
        "token limit",
        "too many tokens",
        "prompt too large"
    )
    foreach ($prop in $Summary.PSObject.Properties) {
        $value = $prop.Value
        if ($value -is [string]) {
            foreach ($pattern in $patterns) {
                if ($value -match [regex]::Escape($pattern)) { return $true }
            }
        }
    }
    return $false
}

function Get-SummaryTextValues {
    <#
    .SYNOPSIS Collect string values from a summary payload (recursive, shallow).
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Value,
        [int]$Depth = 0,
        [int]$MaxDepth = 4
    )
    if ($null -eq $Value) { return @() }
    if ($Depth -gt $MaxDepth) { return @() }

    if ($Value -is [string]) {
        return @($Value)
    }

    $results = @()
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($v in $Value.Values) {
            $results += Get-SummaryTextValues -Value $v -Depth ($Depth + 1) -MaxDepth $MaxDepth
        }
        return $results
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        foreach ($v in $Value) {
            $results += Get-SummaryTextValues -Value $v -Depth ($Depth + 1) -MaxDepth $MaxDepth
        }
        return $results
    }

    if ($Value.PSObject -and $Value.PSObject.Properties) {
        foreach ($prop in $Value.PSObject.Properties) {
            $results += Get-SummaryTextValues -Value $prop.Value -Depth ($Depth + 1) -MaxDepth $MaxDepth
        }
    }
    return $results
}

function Get-AttemptFailureCategory {
    <#
    .SYNOPSIS Classify failure causes from attempt summary payloads.
    #>
    [CmdletBinding()]
    param(
        [object]$Summary,
        [hashtable]$Info
    )
    $latestStatus = $null
    if ($Summary -and $Summary.latest_process_status) {
        $latestStatus = $Summary.latest_process_status
    }
    elseif ($Info -and $Info.last_process_status) {
        $latestStatus = $Info.last_process_status
    }

    $textValues = @()
    if ($Summary) {
        $textValues = Get-SummaryTextValues -Value $Summary
    }
    $combined = ($textValues | Where-Object { $_ -is [string] -and $_.Trim() }) -join "`n"
    $lower = $combined.ToLowerInvariant()

    $apiKeyPatterns = @(
        "api key",
        "api_key",
        "openai_api_key",
        "missing api key",
        "invalid_api_key",
        "unauthorized",
        "authentication",
        "401",
        "403"
    )
    foreach ($pattern in $apiKeyPatterns) {
        if ($lower -match [regex]::Escape($pattern)) {
            return @{ category = "api_key"; status = $latestStatus; detail = $pattern }
        }
    }

    if ($lower -match "context window" -or
        $lower -match "contextwindowexceeded" -or
        $lower -match "ran out of room" -or
        $lower -match "prompt token count" -or
        $lower -match "token count of" -or
        $lower -match "context length exceeded" -or
        $lower -match "maximum context length" -or
        $lower -match "exceeds the limit" -or
        $lower -match "token limit" -or
        $lower -match "too many tokens" -or
        $lower -match "prompt too large") {
        return @{ category = "context_window"; status = $latestStatus; detail = "context window exceeded" }
    }

    $modelErrorPatterns = @(
        "failed to get response from the ai model",
        "capierror",
        "openaierror",
        "model error",
        "model returned an error",
        "upstream error"
    )
    foreach ($pattern in $modelErrorPatterns) {
        if ($lower -match [regex]::Escape($pattern)) {
            return @{ category = "model_error"; status = $latestStatus; detail = $pattern }
        }
    }

    # Agent/AI API rate limits (Copilot, Codex, OpenAI, Anthropic)
    $agentRateLimitPatterns = @(
        '429 Too Many Requests',
        '429',
        'rate limit reached',
        'rate_limit_exceeded',
        'exceeded your current quota',
        'too many requests',
        'request limit reached',
        'throttled',
        'capacity exceeded',
        'overloaded',
        'server is busy',
        'model is currently overloaded',
        'resource_exhausted',
        'quota exceeded'
    )
    foreach ($pattern in $agentRateLimitPatterns) {
        if ($lower -match [regex]::Escape($pattern)) {
            return @{ category = "agent_rate_limit"; status = $latestStatus; detail = $pattern }
        }
    }

    # Check for NO_CHANGES response from agent (indicates task requires no code changes)
    if ($combined -match "(?:^|\n|\s)NO_CHANGES(?:\s|\n|$)") {
        return @{ category = "no_changes"; status = $latestStatus; detail = "agent reported NO_CHANGES" }
    }

    if ($latestStatus -in @("failed", "killed", "crashed", "error", "aborted")) {
        return @{ category = "agent_failed"; status = $latestStatus; detail = $latestStatus }
    }

    return @{ category = "unknown"; status = $latestStatus; detail = $null }
}

function Get-TaskRetryKey {
    param(
        [string]$TaskId,
        [string]$Category
    )
    if (-not $TaskId) { return $Category }
    return "${TaskId}:${Category}"
}

function Increment-TaskRetryCount {
    param(
        [string]$TaskId,
        [string]$Category
    )
    $key = Get-TaskRetryKey -TaskId $TaskId -Category $Category
    $current = 0
    if ($script:TaskRetryCounts.ContainsKey($key)) {
        $current = [int]$script:TaskRetryCounts[$key]
    }
    $current += 1
    $script:TaskRetryCounts[$key] = $current
    return $current
}

function Try-SendFollowUpNewSession {
    <#
    .SYNOPSIS Create a new session and send a follow-up message.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AttemptId,
        [Parameter(Mandatory)][hashtable]$Info,
        [Parameter(Mandatory)][string]$Message,
        [string]$Reason,
        [switch]$IncludeTaskContext = $true
    )

    # ── Global follow-up cap: prevent infinite loops per task ──────────────
    $taskKey = if ($Info.task_id) { $Info.task_id } else { $AttemptId }
    if (-not $script:TaskFollowUpCounts.ContainsKey($taskKey)) {
        $script:TaskFollowUpCounts[$taskKey] = 0
    }
    $script:TaskFollowUpCounts[$taskKey]++
    $followUpCount = $script:TaskFollowUpCounts[$taskKey]
    if ($followUpCount -gt $script:MAX_FOLLOWUPS_PER_TASK) {
        Write-Log "Follow-up cap ($script:MAX_FOLLOWUPS_PER_TASK) exceeded for task $($taskKey.Substring(0,8)) ($followUpCount follow-ups, new session) — marking manual_review" -Level "WARN"
        $Info.status = "manual_review"
        $Info.followup_cap_exceeded = $true
        $Info.pending_followup = $null
        $script:TasksFailed++
        Save-SuccessMetrics
        Try-ArchiveAttempt -AttemptId $AttemptId | Out-Null
        return $false
    }

    if ($Info.status -eq "running" -or $Info.last_process_status -eq "running") {
        Write-Log "Skipping new-session follow-up for $($Info.branch): agent active" -Level "INFO"
        return $false
    }
    $finalMessage = Append-TaskContextToMessage -Message $Message -Info $Info -IncludeContext:$IncludeTaskContext
    $Info.last_followup_message = $finalMessage
    $Info.last_followup_reason = $Reason
    $Info.last_followup_at = Get-Date
    $slots = Get-AvailableSlots
    if ($slots -le 0) {
        Write-Log "Deferring new-session follow-up for $($Info.branch): no available slots" -Level "WARN"
        $Info.pending_followup = @{ message = $finalMessage; reason = $Reason; new_session = $true }
        return $false
    }
    if (-not $DryRun) {
        $session = New-VKSession -WorkspaceId $AttemptId
        if (-not $session) {
            Write-Log "Failed to start new session for $($Info.branch)" -Level "WARN"
            $Info.pending_followup = @{ message = $Message; reason = $Reason; new_session = $true }
            return $false
        }
        $profile = if ($session.executor) { Get-ExecutorProfileForSession -Executor $session.executor } else { Get-CurrentExecutorProfile }
        try {
            Send-VKSessionFollowUp -SessionId $session.id -Message $finalMessage -ExecutorProfile $profile | Out-Null
        }
        catch {
            Write-Log "New-session follow-up failed for $($Info.branch): $($_.Exception.Message)" -Level "WARN"
            $Info.pending_followup = @{ message = $finalMessage; reason = $Reason; new_session = $true }
            return $false
        }
    }
    $Info.pending_followup = $null
    $Info.status = "running"
    $taskUrl = if ($Info.task_id) { Get-TaskUrl -TaskId $Info.task_id } else { $null }
    Add-RecentItem -ListName "FollowUpEvents" -Item @{
        task_id     = $Info.task_id
        task_title  = $Info.name
        attempt_id  = $AttemptId
        branch      = $Info.branch
        reason      = $Reason
        task_url    = $taskUrl
        occurred_at = (Get-Date).ToString("o")
    }
    return $true
}

function Try-RecoverContextWindow {
    <#
    .SYNOPSIS Create a new session and re-send the last follow-up when context is exhausted.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AttemptId,
        [Parameter(Mandatory)][hashtable]$Info
    )
    if ($Info.status -eq "running" -or $Info.last_process_status -eq "running") {
        return $false
    }

    $slots = Get-AvailableSlots
    if ($slots -le 0) {
        Write-Log "Deferring context recovery for $($Info.branch): no available slots" -Level "WARN"
        $Info.context_recovery_pending = $true
        return $false
    }

    $session = New-VKSession -WorkspaceId $AttemptId
    if (-not $session) {
        Write-Log "Failed to create new session for $($Info.branch)" -Level "WARN"
        return $false
    }

    $Info.context_recovery_pending = $false
    $Info.context_recovery_attempted_at = Get-Date
    $Info.status = "running"

    $profile = if ($session.executor) {
        Get-ExecutorProfileForSession -Executor $session.executor
    }
    else {
        Get-ExecutorProfileForSession -Executor "CODEX"
    }
    $message = Get-ContextRecoveryMessage -Info $Info
    $Info.last_followup_message = $message
    $Info.last_followup_reason = "context_window_recovery"
    $Info.last_followup_at = Get-Date
    $sent = Send-VKSessionFollowUp -SessionId $session.id -Message $message -ExecutorProfile $profile
    if (-not $sent) {
        Write-Log "Follow-up resend failed for $($Info.branch)" -Level "WARN"
        return $false
    }

    Write-Log "Context recovery started for $($Info.branch) via new session" -Level "INFO"
    return $true
}

function Merge-PRWithFallback {
    <#
    .SYNOPSIS Merge a PR, optionally using admin override and retrying when out of date.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [switch]$ForceAdmin
    )
    $merged = Merge-PR -PRNumber $PRNumber -Admin:$ForceAdmin
    if (Test-GithubRateLimit) { return @{ merged = $false; reason = "rate_limit"; used_admin = $ForceAdmin } }
    if ($merged) { return @{ merged = $true; reason = $null; used_admin = $ForceAdmin } }

    $mergeErr = Get-VKLastGithubError
    $reason = if ($mergeErr -and $mergeErr.message) { $mergeErr.message } else { "Unknown merge error" }
    if ($reason -match "not up to date|not mergeable") {
        Write-Log "Retrying merge with admin override for PR #$PRNumber" -Level "WARN"
        $mergedAdmin = Merge-PR -PRNumber $PRNumber -Admin
        if (Test-GithubRateLimit) { return @{ merged = $false; reason = "rate_limit"; used_admin = $true } }
        if ($mergedAdmin) { return @{ merged = $true; reason = $null; used_admin = $true } }
        return @{ merged = $false; reason = $reason; used_admin = $true }
    }

    return @{ merged = $false; reason = $reason; used_admin = $ForceAdmin }
}

function Resolve-PRBaseBranch {
    <#
    .SYNOPSIS Determine the correct base branch for a PR/attempt.
              Uses PR's actual base, then tracked target_branch, then task-level
              upstream detection, then falls back to VK_TARGET_BRANCH.
    #>
    [CmdletBinding()]
    param(
        [hashtable]$Info,
        [object]$PRDetails
    )
    # 1. Use PR's declared base branch (most authoritative)
    if ($PRDetails -and $PRDetails.baseRefName) {
        $base = $PRDetails.baseRefName
        if ($base -like "origin/*") { $base = $base.Substring(7) }
        return $base
    }
    # 2. Use stored target_branch from submission
    if ($Info -and $Info.target_branch) {
        $base = $Info.target_branch
        if ($base -like "origin/*") { $base = $base.Substring(7) }
        return $base
    }
    # 3. Try task-level detection via task_id
    if ($Info -and $Info.task_id) {
        try {
            $taskData = Get-VKTask -TaskId $Info.task_id
            if ($taskData) {
                $taskObj = [pscustomobject]$taskData
                $upstream = Get-TaskUpstreamBranch -Task $taskObj
                if ($upstream) {
                    $base = $upstream
                    if ($base -like "origin/*") { $base = $base.Substring(7) }
                    return $base
                }
            }
        }
        catch {
            # Best effort — fall through
        }
    }
    # 4. Fallback
    $base = $script:VK_TARGET_BRANCH
    if ($base -like "origin/*") { $base = $base.Substring(7) }
    return $base
}

# ── Persistent rebase cooldown (survives orchestrator restarts) ──────────────
function Get-RebaseCooldownState {
    <#
    .SYNOPSIS Load rebase cooldown state from disk.
             Returns hashtable of branch → { attempted_at, cooldown_until }.
    #>
    if (-not (Test-Path $script:RebaseCooldownPath)) { return @{} }
    try {
        $raw = Get-Content $script:RebaseCooldownPath -Raw -ErrorAction Stop | ConvertFrom-Json
        $state = @{}
        foreach ($prop in $raw.PSObject.Properties) {
            $state[$prop.Name] = @{
                attempted_at   = $prop.Value.attempted_at
                cooldown_until = $prop.Value.cooldown_until
            }
        }
        return $state
    }
    catch {
        return @{}
    }
}

function Set-RebaseCooldownState {
    param([hashtable]$State)
    try {
        $dir = Split-Path $script:RebaseCooldownPath -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $State | ConvertTo-Json -Depth 3 | Set-Content $script:RebaseCooldownPath -Encoding UTF8 -Force
    }
    catch {
        Write-Log "Failed to persist rebase cooldown: $($_.Exception.Message)" -Level "WARN"
    }
}

function Test-RebaseCooldown {
    <#
    .SYNOPSIS Check if a branch is on rebase cooldown (persisted to disk).
             Returns $true if the branch should NOT be rebased yet.
    #>
    param([Parameter(Mandatory)][string]$Branch)
    $state = Get-RebaseCooldownState
    if (-not $state.ContainsKey($Branch)) { return $false }
    $entry = $state[$Branch]
    $until = [DateTime]::Parse($entry.cooldown_until)
    return ([DateTime]::UtcNow -lt $until)
}

function Set-RebaseCooldown {
    <#
    .SYNOPSIS Mark a branch as recently rebased (30-min cooldown, persisted to disk).
    #>
    param(
        [Parameter(Mandatory)][string]$Branch,
        [int]$CooldownMinutes = 30
    )
    $state = Get-RebaseCooldownState
    $state[$Branch] = @{
        attempted_at   = [DateTime]::UtcNow.ToString("o")
        cooldown_until = [DateTime]::UtcNow.AddMinutes($CooldownMinutes).ToString("o")
    }
    # Prune entries older than 24h
    $cutoff = [DateTime]::UtcNow.AddHours(-24)
    $pruned = @{}
    foreach ($key in $state.Keys) {
        try {
            $until = [DateTime]::Parse($state[$key].cooldown_until)
            if ($until -gt $cutoff) { $pruned[$key] = $state[$key] }
        }
        catch { $pruned[$key] = $state[$key] }
    }
    Set-RebaseCooldownState -State $pruned
}

# ── Worktree path resolution ────────────────────────────────────────────────
function Get-WorktreePathForBranch {
    <#
    .SYNOPSIS Find the worktree directory for a given branch name.
             Returns $null if no worktree exists for that branch.
    #>
    param([Parameter(Mandatory)][string]$Branch)
    $porcelain = git worktree list --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    $currentWorktree = $null
    foreach ($line in $porcelain) {
        $lineStr = $line.ToString().Trim()
        if ($lineStr -match '^worktree (.+)$') {
            $currentWorktree = $Matches[1].Trim()
        }
        elseif ($lineStr -match '^branch refs/heads/(.+)$') {
            $branchName = $Matches[1].Trim()
            if ($branchName -eq $Branch -and $currentWorktree) {
                return $currentWorktree
            }
        }
    }
    return $null
}

function Test-GitRebaseInProgress {
    <#
    .SYNOPSIS Check if a git rebase is in progress in a given directory.
    #>
    param([string]$RepoPath = ".")
    $gitDir = git -C $RepoPath rev-parse --git-dir 2>&1
    if ($LASTEXITCODE -ne 0) { return $false }
    $gitDirStr = $gitDir.ToString().Trim()
    # Resolve relative to repo path
    if (-not [System.IO.Path]::IsPathRooted($gitDirStr)) {
        $gitDirStr = Join-Path $RepoPath $gitDirStr
    }
    return ((Test-Path (Join-Path $gitDirStr "rebase-merge")) -or (Test-Path (Join-Path $gitDirStr "rebase-apply")))
}

function Test-GitWorktreeClean {
    <#
    .SYNOPSIS Run git status and verify the working tree is clean.
    .DESCRIPTION Logs a short git status output and returns $true when clean.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoPath,
        [string]$Label = $RepoPath
    )

    $statusShort = git -C $RepoPath status --short --branch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "git status failed for ${Label}: $statusShort" -Level "WARN"
        return $false
    }
    if ($statusShort) {
        Write-Log "git status [$Label]: $statusShort" -Level "DEBUG"
    }
    else {
        Write-Log "git status [$Label]: (no output)" -Level "DEBUG"
    }

    $porcelain = git -C $RepoPath status --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "git status --porcelain failed for ${Label}: $porcelain" -Level "WARN"
        return $false
    }
    if ($porcelain) { return $false }
    return $true
}

function Get-TempWorktreePath {
    <#
    .SYNOPSIS Create a unique temporary worktree path under the system temp dir.
    #>
    param(
        [Parameter(Mandatory)][string]$Branch,
        [string]$Prefix = "vk-rebase"
    )

    $tempRoot = Get-EnvFallback -Name "TEMP"
    if (-not $tempRoot) { $tempRoot = Get-EnvFallback -Name "TMP" }
    if (-not $tempRoot) { $tempRoot = [IO.Path]::GetTempPath() }

    $safeBranch = ($Branch -replace '[^a-zA-Z0-9._-]', '-')
    if ([string]::IsNullOrWhiteSpace($safeBranch)) { $safeBranch = "branch" }
    if ($safeBranch.Length -gt 42) { $safeBranch = $safeBranch.Substring(0, 42) }

    $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
    $leaf = "$Prefix-$safeBranch-$suffix"
    return (Join-Path $tempRoot $leaf)
}

function Invoke-DirectRebaseIsolatedWorktree {
    <#
    .SYNOPSIS Rebase/merge a branch using a detached temporary worktree.
    .DESCRIPTION
    Used when the branch's primary worktree is dirty or locked. This avoids
    polluting active agent worktrees and prevents "full repo reupload" states.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Branch,
        [string]$BaseBranch = "main",
        [string]$AttemptId
    )

    Write-Log "Attempting isolated direct rebase of $Branch onto $BaseBranch" -Level "ACTION"

    $tempWorktreePath = $null
    $addedWorktree = $false
    try {
        $tempWorktreePath = Get-TempWorktreePath -Branch $Branch -Prefix "vk-rebase"
        $parentDir = Split-Path -Parent $tempWorktreePath
        if ($parentDir -and -not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        $fetchOut = git fetch origin $Branch $BaseBranch 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git fetch failed: $fetchOut"
        }

        $addOut = git worktree add "$tempWorktreePath" "origin/$Branch" --detach 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git worktree add failed: $addOut"
        }
        $addedWorktree = $true

        # Hard-clean the isolated worktree to remove any stale filesystem residue.
        git -C $tempWorktreePath reset --hard HEAD 2>&1 | Out-Null
        git -C $tempWorktreePath clean -fdx 2>&1 | Out-Null

        $mergeOut = git -C $tempWorktreePath merge "origin/$BaseBranch" --no-edit 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "Isolated merge conflicts detected for $Branch — attempting auto-resolve" -Level "INFO"
            Push-Location $tempWorktreePath
            try {
                $resolved = Resolve-MergeConflicts
            }
            finally {
                Pop-Location
            }

            if (-not $resolved) {
                Write-Log "Isolated merge has non-auto-resolvable conflicts for $Branch" -Level "WARN"
                git -C $tempWorktreePath merge --abort 2>&1 | Out-Null
                Set-RebaseCooldown -Branch $Branch -CooldownMinutes 10
                if ($AttemptId) {
                    return Rebase-VKAttempt -AttemptId $AttemptId -BaseBranch $BaseBranch
                }
                return $false
            }
            Write-Log "Isolated merge auto-resolved conflicts for $Branch" -Level "OK"
        }

        $pushOut = git -C $tempWorktreePath push origin "HEAD:$Branch" 2>&1
        if ($LASTEXITCODE -ne 0) {
            $pushOut2 = git -C $tempWorktreePath push origin "HEAD:$Branch" --force-with-lease 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "push failed: $pushOut2"
            }
        }

        Write-Log "Isolated direct rebase succeeded for $Branch onto $BaseBranch" -Level "OK"
        return $true
    }
    catch {
        Write-Log "Isolated direct rebase failed for ${Branch}: $($_.Exception.Message)" -Level "WARN"
        Set-RebaseCooldown -Branch $Branch -CooldownMinutes 20
        if ($AttemptId) {
            return Rebase-VKAttempt -AttemptId $AttemptId -BaseBranch $BaseBranch
        }
        return $false
    }
    finally {
        if ($addedWorktree -and $tempWorktreePath) {
            git worktree remove "$tempWorktreePath" --force 2>&1 | Out-Null
        }
        if ($tempWorktreePath -and (Test-Path $tempWorktreePath)) {
            Remove-Item -Path $tempWorktreePath -Recurse -Force -ErrorAction SilentlyContinue
        }
        git worktree prune 2>&1 | Out-Null
    }
}

function Invoke-DirectRebase {
    <#
    .SYNOPSIS Smart rebase of a PR branch onto its base branch.
              Uses the worktree (if available) instead of the main repo checkout.
              Uses merge-based approach for reliability.
              Handles auto-resolvable conflicts (lock files, generated files)
              before falling back to VK rebase.
              Includes persistent cooldown to prevent retry storms across restarts.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Branch,
        [string]$BaseBranch = "main",
        [string]$AttemptId
    )

    Write-Log "Attempting direct rebase of $Branch onto $BaseBranch" -Level "ACTION"

    # ── Guard 1: Persistent cooldown check (survives restarts) ──────────
    if (Test-RebaseCooldown -Branch $Branch) {
        Write-Log "Branch $Branch is on rebase cooldown — skipping" -Level "INFO"
        return $false
    }

    # ── Guard 2: Find the correct working directory ─────────────────────
    $worktreePath = Get-WorktreePathForBranch -Branch $Branch
    $useWorktree = $false
    if ($worktreePath -and (Test-Path $worktreePath)) {
        # ── Guard 3: Check for in-progress rebase in the worktree ───────
        if (Test-GitRebaseInProgress -RepoPath $worktreePath) {
            Write-Log "Worktree $worktreePath has rebase in progress — aborting it first" -Level "WARN"
            git -C $worktreePath rebase --abort 2>&1 | Out-Null
        }
        # ── Guard 4: Check for dirty working tree ───────────────────────
        if (-not (Test-GitWorktreeClean -RepoPath $worktreePath -Label $worktreePath)) {
            Write-Log "Worktree $worktreePath has uncommitted changes — using isolated worktree for rebase" -Level "INFO"
            return Invoke-DirectRebaseIsolatedWorktree -Branch $Branch -BaseBranch $BaseBranch -AttemptId $AttemptId
        }
        $useWorktree = $true
        Write-Log "Using worktree at $worktreePath for rebase" -Level "INFO"
    }
    else {
        # No worktree — fall back to VK API rebase (do NOT use main repo checkout)
        Write-Log "No worktree found for $Branch — using VK API rebase only" -Level "INFO"
        Set-RebaseCooldown -Branch $Branch -CooldownMinutes 30
        if ($AttemptId) { return Rebase-VKAttempt -AttemptId $AttemptId }
        return $false
    }

    # ── Perform merge-based update in the worktree ──────────────────────
    try {
        # Fetch latest from origin
        $fetchOut = git -C $worktreePath fetch origin $BaseBranch 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "git fetch failed in worktree: $fetchOut" -Level "WARN"
            Set-RebaseCooldown -Branch $Branch -CooldownMinutes 10
            if ($AttemptId) { return Rebase-VKAttempt -AttemptId $AttemptId }
            return $false
        }

        # Use merge instead of rebase — less conflict-prone, preserves commit history
        $mergeOut = git -C $worktreePath merge "origin/$BaseBranch" --no-edit 2>&1
        if ($LASTEXITCODE -ne 0) {
            # Merge hit conflicts — try auto-resolving
            Write-Log "Merge conflicts detected — attempting auto-resolve" -Level "INFO"
            Push-Location $worktreePath
            try {
                $resolved = Resolve-MergeConflicts
                if (-not $resolved) {
                    # ── SDK resolver mode: leave merge in progress ──────────
                    # Instead of aborting the merge, leave it in progress so
                    # the monitor's SDK resolver (sdk-conflict-resolver.mjs)
                    # can read conflict markers and resolve semantically.
                    Write-Log "Merge has semantic conflicts — leaving merge in progress for SDK resolver (worktree: $worktreePath)" -Level "INFO"
                    Set-RebaseCooldown -Branch $Branch -CooldownMinutes 5
                    return "sdk_needed"
                }
                Write-Log "Auto-resolved merge conflicts for $Branch" -Level "OK"
            }
            finally {
                Pop-Location
            }
        }

        # Push the merged result
        $pushOut = git -C $worktreePath push origin "HEAD:$Branch" 2>&1
        if ($LASTEXITCODE -ne 0) {
            $pushOut2 = git -C $worktreePath push origin "HEAD:$Branch" --force-with-lease 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "push failed: $pushOut2"
            }
        }

        Write-Log "Direct merge-rebase succeeded for $Branch onto $BaseBranch" -Level "OK"
        return $true
    }
    catch {
        Write-Log "Direct rebase failed: $($_.Exception.Message) — setting cooldown" -Level "WARN"
        Set-RebaseCooldown -Branch $Branch -CooldownMinutes 30
        if ($AttemptId) {
            return Rebase-VKAttempt -AttemptId $AttemptId
        }
        return $false
    }
}

# ── VK rebase fallback ──────────────────────────────────────────────────────
function Rebase-VKAttempt {
    <#
    .SYNOPSIS
        Request a server-side rebase for an attempt via ve-kanban.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AttemptId,
        [string]$BaseBranch = $script:VK_TARGET_BRANCH
    )

    if (-not (Get-Command Invoke-VKRebase -ErrorAction SilentlyContinue)) {
        Write-Log "VK rebase unavailable (Invoke-VKRebase not loaded) for attempt $AttemptId" -Level "WARN"
        return $false
    }

    try {
        $result = Invoke-VKRebase -AttemptId $AttemptId -BaseBranch $BaseBranch
        if ($result) {
            Write-Log "VK rebase requested for attempt $AttemptId" -Level "INFO"
            return $true
        }
    }
    catch {
        Write-Log "VK rebase failed for attempt ${AttemptId}: $($_.Exception.Message)" -Level "WARN"
    }

    return $false
}

# ── Auto-resolvable file patterns for rebase conflicts ────────────────────
$script:AutoResolveTheirs = @(
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "go.sum",
    "*.lock"
)
$script:AutoResolveOurs = @(
    "CHANGELOG.md",
    "coverage.txt",
    "results.txt"
)

function Test-AutoResolvable {
    <#
    .SYNOPSIS Check if a conflicted file can be auto-resolved.
    .RETURNS "theirs", "ours", or $null (manual resolution required)
    #>
    param([string]$FilePath)
    $fileName = Split-Path -Leaf $FilePath
    foreach ($pattern in $script:AutoResolveTheirs) {
        if ($fileName -like $pattern) { return "theirs" }
    }
    foreach ($pattern in $script:AutoResolveOurs) {
        if ($fileName -like $pattern) { return "ours" }
    }
    return $null
}

function Resolve-RebaseConflicts {
    <#
    .SYNOPSIS Attempt to auto-resolve rebase conflicts during an active rebase.
              Resolves lock files as "theirs", changelog as "ours", etc.
              If any file is NOT auto-resolvable, returns $false.
              Loops through all conflicting commits until rebase completes.
    #>
    param([string]$BaseBranch = "main")

    $maxIterations = 50  # Safety: prevent infinite loops
    for ($i = 0; $i -lt $maxIterations; $i++) {
        # Get conflicted files
        $conflicted = @(git diff --name-only --diff-filter=U 2>&1)
        if ($LASTEXITCODE -ne 0 -or $conflicted.Count -eq 0) {
            # Check if rebase is still in progress
            $rebaseDir = git rev-parse --git-dir 2>&1
            if (Test-Path "$rebaseDir/rebase-merge" -ErrorAction SilentlyContinue) {
                # No conflicts but rebase continues — run continue
                git rebase --continue 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) { return $true }
                continue
            }
            # Rebase completed
            return $true
        }

        $allResolvable = $true
        foreach ($file in $conflicted) {
            $file = $file.Trim()
            if ([string]::IsNullOrWhiteSpace($file)) { continue }
            $strategy = Test-AutoResolvable -FilePath $file
            if (-not $strategy) {
                Write-Log "Cannot auto-resolve: $file (manual resolution needed)" -Level "WARN"
                $allResolvable = $false
                break
            }
            # Apply resolution strategy
            if ($strategy -eq "theirs") {
                git checkout --theirs -- $file 2>&1 | Out-Null
            }
            else {
                git checkout --ours -- $file 2>&1 | Out-Null
            }
            git add $file 2>&1 | Out-Null
            Write-Log "Auto-resolved conflict ($strategy): $file" -Level "INFO"
        }

        if (-not $allResolvable) { return $false }

        # Continue the rebase
        Set-EnvValue -Name "GIT_EDITOR" -Value "true"  # Don't open editor for commit messages
        $continueOut = git rebase --continue 2>&1
        Set-EnvValue -Name "GIT_EDITOR" -Value $null
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        # If rebase continue fails with more conflicts, loop will retry
    }
    Write-Log "Auto-resolve exhausted $maxIterations iterations" -Level "WARN"
    return $false
}

function Resolve-MergeConflicts {
    <#
    .SYNOPSIS Attempt to auto-resolve merge conflicts (non-rebase context).
              Resolves lock files as "theirs", changelog as "ours", etc.
              If any file is NOT auto-resolvable, returns $false.
    #>
    $conflicted = @(git diff --name-only --diff-filter=U 2>&1)
    if ($LASTEXITCODE -ne 0 -or $conflicted.Count -eq 0) {
        return $true  # No conflicts
    }

    foreach ($file in $conflicted) {
        $file = $file.ToString().Trim()
        if ([string]::IsNullOrWhiteSpace($file)) { continue }
        $strategy = Test-AutoResolvable -FilePath $file
        if (-not $strategy) {
            Write-Log "Cannot auto-resolve merge conflict: $file (manual resolution needed)" -Level "WARN"
            return $false
        }
        if ($strategy -eq "theirs") {
            git checkout --theirs -- $file 2>&1 | Out-Null
        }
        else {
            git checkout --ours -- $file 2>&1 | Out-Null
        }
        git add $file 2>&1 | Out-Null
        Write-Log "Auto-resolved merge conflict ($strategy): $file" -Level "INFO"
    }

    # Commit the merge resolution
    # Set git editor to colon (POSIX no-op) and disable merge commit editor
    $env:GIT_EDITOR = ":"
    $env:GIT_MERGE_AUTOEDIT = "no"
    git commit --no-edit 2>&1 | Out-Null
    $env:GIT_EDITOR = $null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Failed to commit merge resolution" -Level "WARN"
        return $false
    }
    return $true
}

function Get-MergeFailureInfo {
    <#
    .SYNOPSIS Classify merge failures with PR metadata for clearer diagnostics.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [string]$Reason
    )
    $details = Get-PRDetails -PRNumber $PRNumber
    if (Test-GithubRateLimit) {
        return @{ category = "rate_limit"; action = "wait"; summary = "rate limit"; reason = $Reason }
    }

    $mergeState = if ($details -and $details.mergeStateStatus) { $details.mergeStateStatus } else { "UNKNOWN" }
    $reviewDecision = if ($details -and $details.reviewDecision) { $details.reviewDecision } else { "UNKNOWN" }
    $isDraft = if ($details) { [bool]$details.isDraft } else { $false }

    $category = "unknown"
    $action = "review"

    if ($mergeState -in @("DIRTY", "CONFLICTING")) {
        $category = "conflict"
        $action = "resolve_conflicts"
    }
    elseif ($mergeState -eq "BEHIND") {
        $category = "behind"
        $action = "rebase"
    }
    elseif ($mergeState -eq "BLOCKED") {
        $category = "blocked"
        $action = "checks_or_reviews"
    }
    elseif ($isDraft) {
        $category = "draft"
        $action = "mark_ready"
    }

    if ($reviewDecision -in @("REVIEW_REQUIRED", "CHANGES_REQUESTED")) {
        $category = "review_required"
        $action = "request_review"
    }

    if ($Reason -match "policy prohibits|base branch policy") {
        $category = "policy"
        $action = "admin_or_reviews"
    }
    elseif ($Reason -match "Base branch was modified") {
        $category = "base_changed"
        $action = "retry"
    }
    elseif ($Reason -match "not up to date|not mergeable") {
        $category = "behind"
        $action = "rebase"
    }
    elseif ($Reason -match "rate limit|abuse detection|secondary rate limit") {
        $category = "rate_limit"
        $action = "wait"
    }

    $summary = "state=$mergeState review=$reviewDecision category=$category action=$action"
    return @{ category = $category; action = $action; summary = $summary; reason = $Reason; merge_state = $mergeState; review_decision = $reviewDecision }
}

function Get-MergeCandidates {
    <#
    .SYNOPSIS Collect PRs eligible for merge (idle agent, CI passing, age >= CiWaitMin).
    #>
    $candidates = @()
    $candidateNumbers = @{}
    foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
        $attemptId = $entry.Key
        $info = $entry.Value

        if ($info.status -in @("merged", "done", "running")) { continue }
        if ($info.last_process_status -eq "running") { continue }
        if (-not $info.branch) { continue }

        $pr = Get-PRForBranch -Branch $info.branch
        if (Test-GithubRateLimit) { return @() }
        if (-not $pr) { continue }

        if ($pr.state -eq "MERGED" -or $pr.mergedAt) {
            Complete-Task -AttemptId $attemptId -TaskId $info.task_id -PRNumber $pr.number
            continue
        }

        $prDetails = Get-PRDetails -PRNumber $pr.number
        if (Test-GithubRateLimit) { return @() }
        $mergeState = if ($prDetails -and $prDetails.mergeStateStatus) { $prDetails.mergeStateStatus } else { "UNKNOWN" }
        if ($mergeState -in @("DIRTY", "CONFLICTING")) { continue }

        $baseBranch = if ($prDetails -and $prDetails.baseRefName) { $prDetails.baseRefName } else { $script:VK_TARGET_BRANCH }
        if ($baseBranch -like "origin/*") { $baseBranch = $baseBranch.Substring(7) }
        $checkStatus = Get-PRRequiredCheckStatus -PRNumber $pr.number -BaseBranch $baseBranch
        if (Test-GithubRateLimit) { return @() }
        if ($checkStatus -ne "passing") { continue }

        $candidates += [pscustomobject]@{
            attempt_id = $attemptId
            task_id    = $info.task_id
            branch     = $info.branch
            pr_number  = $pr.number
            created_at = $pr.createdAt
        }
        $candidateNumbers[$pr.number] = $true
    }

    $openPrs = Get-OpenPullRequests
    if (Test-GithubRateLimit) { return @() }
    foreach ($pr in $openPrs) {
        if (-not $pr.author -or -not (Test-IsCopilotAuthor -Author $pr.author)) { continue }
        if ($candidateNumbers.ContainsKey($pr.number)) { continue }

        $prDetails = Get-PRDetails -PRNumber $pr.number
        if (Test-GithubRateLimit) { return @() }
        $mergeState = if ($prDetails -and $prDetails.mergeStateStatus) { $prDetails.mergeStateStatus } else { "UNKNOWN" }
        if ($mergeState -in @("DIRTY", "CONFLICTING")) { continue }

        $baseBranch = if ($pr.baseRefName) { $pr.baseRefName } else { $script:VK_TARGET_BRANCH }
        if ($baseBranch -like "origin/*") { $baseBranch = $baseBranch.Substring(7) }
        $checkStatus = Get-PRRequiredCheckStatus -PRNumber $pr.number -BaseBranch $baseBranch
        if (Test-GithubRateLimit) { return @() }
        if ($checkStatus -ne "passing") { continue }

        if ($pr.isDraft) {
            $null = Mark-PRReady -PRNumber $pr.number
        }

        $candidates += [pscustomobject]@{
            attempt_id = $null
            task_id    = $null
            branch     = $pr.headRefName
            pr_number  = $pr.number
            created_at = $pr.createdAt
        }
        $candidateNumbers[$pr.number] = $true
    }
    $candidates = $candidates | Sort-Object -Property {
        if ($_.created_at) {
            try { [datetime]::Parse($_.created_at) } catch { [datetime]::MaxValue }
        }
        else { [datetime]::MaxValue }
    }
    return $candidates
}

# ─── Core Orchestration ──────────────────────────────────────────────────────

function Sync-TrackedAttempts {
    <#
    .SYNOPSIS Refresh tracked attempts from vibe-kanban API + discover new active ones.
    #>
    $apiAttempts = Get-VKAttempts -ActiveOnly
    $summaries = Get-VKAttemptSummaries -Archived:$false
    if (-not $apiAttempts) { return }

    $summaryMap = @{}
    foreach ($s in $summaries) {
        if ($s.workspace_id) { $summaryMap[$s.workspace_id] = $s }
    }
    $script:AttemptSummaries = $summaryMap

    foreach ($a in $apiAttempts) {
        if (-not $a.branch) { continue }
        # Skip attempts we already fully processed (prevents re-tracking when archive fails with 405)
        if ($script:ProcessedAttemptIds.Contains($a.id)) { continue }
        $execProfile = Get-AttemptExecutorProfile -Attempt $a
        if (-not $script:TrackedAttempts.ContainsKey($a.id)) {
            # Newly discovered active attempt
            $script:TrackedAttempts[$a.id] = @{
                task_id                       = $a.task_id
                branch                        = $a.branch
                pr_number                     = $null
                status                        = "running"
                name                          = $a.name
                task_title_cached             = $a.name
                task_description_cached       = $null
                updated_at                    = $a.updated_at
                container_ref                 = $a.container_ref
                executor                      = $execProfile.executor
                executor_variant              = $execProfile.variant
                ci_notified                   = $false
                conflict_notified             = $false
                rebase_requested              = $false
                idle_detected_at              = $null
                review_marked                 = $false
                error_notified                = $false
                push_notified                 = $false
                merge_failed_notified         = $false
                merge_failures_total          = 0
                merge_failure_cycles          = 0
                last_merge_notify_at          = $null
                last_merge_failure_reason     = $null
                last_merge_failure_category   = $null
                last_merge_failure_at         = $null
                manual_review_notified        = $false
                last_process_status           = $null
                last_process_completed_at     = $null
                pending_followup              = $null
                last_followup_message         = $null
                last_followup_reason          = $null
                last_followup_at              = $null
                context_recovery_pending      = $false
                context_recovery_attempted_at = $null
                copilot_fix_requested         = $false
                copilot_fix_requested_at      = $null
                copilot_fix_pr_number         = $null
                copilot_fix_merged            = $false
                copilot_fix_merged_at         = $null
                no_commits_retries            = 0
                conflict_rebase_attempted     = $false
                stale_running_detected_at     = $null
                plan_continue_sent            = $false
            }
            Write-Log "Tracking new attempt: $($a.id.Substring(0,8)) → $($a.branch)" -Level "INFO"

            # ── Agent Work Logger: start session ──
            if ($script:AgentWorkLoggerEnabled) {
                try {
                    Start-AgentSession -AttemptId $a.id `
                        -TaskMetadata @{
                        task_id    = $a.task_id
                        task_title = $a.name
                    } `
                        -ExecutorInfo @{
                        executor         = if ($execProfile) { $execProfile.executor } else { "unknown" }
                        executor_variant = if ($execProfile) { $execProfile.variant } else { $null }
                    } `
                        -GitContext @{
                        branch = $a.branch
                    }
                }
                catch {
                    Write-Log "Agent work logger Start-AgentSession failed: $($_.Exception.Message)" -Level "WARN"
                }
            }
        }
        else {
            $script:TrackedAttempts[$a.id].updated_at = $a.updated_at
            $script:TrackedAttempts[$a.id].container_ref = $a.container_ref
            if ($execProfile) {
                if (-not $script:TrackedAttempts[$a.id].executor -and $execProfile.executor) {
                    $script:TrackedAttempts[$a.id].executor = $execProfile.executor
                }
                if (-not $script:TrackedAttempts[$a.id].executor_variant -and $execProfile.variant) {
                    $script:TrackedAttempts[$a.id].executor_variant = $execProfile.variant
                }
            }
        }

        $summary = $summaryMap[$a.id]
        if ($summary) {
            $tracked = $script:TrackedAttempts[$a.id]
            $tracked.last_process_status = $summary.latest_process_status
            $tracked.last_process_completed_at = $summary.latest_process_completed_at

            if ($summary.latest_process_status -eq "running") {
                # Agent is active again; treat as running to avoid review actions
                $tracked.status = "running"
                $tracked.review_marked = $false
                $tracked.error_notified = $false
                $tracked.ci_notified = $false
                $tracked.pending_followup = $null
                $tracked.stale_running_detected_at = $null  # Reset stale timer — agent is alive
            }
            elseif ($summary.latest_process_status -in @("completed", "failed")) {
                if ($tracked.status -eq "running") {
                    $tracked.status = "review"
                }
                if (-not $tracked.review_marked) {
                    Write-Log "Attempt $($a.id.Substring(0,8)) finished ($($summary.latest_process_status)) — marking review" -Level "INFO"
                    if (-not $DryRun) {
                        Update-VKTaskStatus -TaskId $tracked.task_id -Status "inreview" | Out-Null
                    }
                    $tracked.review_marked = $true

                    # ── Plan-only completion detection ────────────────────────
                    # If the agent completed "successfully" but made zero commits
                    # (e.g. it created a plan and asked "should I implement?"),
                    # send a same-session follow-up telling it to continue.
                    if ($summary.latest_process_status -eq "completed" -and -not $tracked.plan_continue_sent) {
                        $branchForCheck = $tracked.branch
                        if ($branchForCheck) {
                            # Fetch remote refs first so Get-CommitsAhead sees remote branch
                            git fetch origin $branchForCheck --quiet 2>$null
                            $ahead = Get-CommitsAhead -Branch "origin/$branchForCheck"
                            if ($ahead -eq 0) {
                                Write-Log "Attempt $($a.id.Substring(0,8)) completed with 0 commits — plan-only detected, sending continue follow-up (same session)" -Level "ACTION"
                                $tracked.plan_continue_sent = $true
                                $planMsg = @"
You created a plan but did NOT implement it. The session completed with 0 code changes.

DO NOT ask for confirmation — start implementing NOW. Work through each task in the plan systematically:
1. Write the actual code changes
2. Write or update tests
3. Commit each completed task
4. Push when done

Do NOT create another plan or summary. Write real code.
"@
                                $tracked.pending_followup = @{
                                    message     = $planMsg.Trim()
                                    reason      = "plan_only_completion"
                                    new_session = $false
                                }
                            }
                            elseif ($ahead -gt 0) {
                                Write-Log "Attempt $($a.id.Substring(0,8)) completed with $ahead commit(s) — real work done" -Level "INFO"
                            }
                        }
                    }

                    # ── Agent Work Logger: stop session ──
                    if ($script:AgentWorkLoggerEnabled) {
                        try {
                            $completionStatus = if ($summary.latest_process_status -eq "completed") { "success" } else { "failed" }
                            Stop-AgentSession -AttemptId $a.id -CompletionStatus $completionStatus
                        }
                        catch {
                            Write-Log "Agent work logger Stop-AgentSession failed: $($_.Exception.Message)" -Level "WARN"
                        }
                    }
                }
                if ($summary.latest_process_status -eq "failed" -and -not $tracked.error_notified) {
                    Write-Log "Attempt $($a.id.Substring(0,8)) failed in workspace — requires agent attention" -Level "WARN"
                    $tracked.error_notified = $true
                    $tracked.status = "error"

                    # ── Agent Work Logger: log error ──
                    if ($script:AgentWorkLoggerEnabled) {
                        try {
                            Write-AgentError -AttemptId $a.id `
                                -ErrorMessage "Agent workspace process failed" `
                                -ErrorCategory "workspace_failure"
                        }
                        catch {
                            # best effort
                        }
                    }
                }

                if ($summary.latest_process_status -eq "failed") {
                    $failure = Get-AttemptFailureCategory -Summary $summary -Info $tracked
                    if ($failure.category -in @("context_window", "model_error")) {
                        $tracked.force_new_session = $true
                        $shouldRecover = $true
                        if ($tracked.context_recovery_attempted_at) {
                            $sinceAttempt = ((Get-Date) - $tracked.context_recovery_attempted_at).TotalMinutes
                            if ($sinceAttempt -lt 10) { $shouldRecover = $false }
                        }
                        if ($shouldRecover) {
                            $null = Try-RecoverContextWindow -AttemptId $a.id -Info $tracked
                        }
                    }
                }
            }
        }

        $tracked = $script:TrackedAttempts[$a.id]
        if ($tracked) {
            Update-TaskContextCache -Info $tracked
        }
    }

    # De-duplicate active attempts for the same task (keep most recent)
    $attemptsByTask = @{}
    foreach ($a in $apiAttempts) {
        if (-not $a.task_id) { continue }
        if (-not $attemptsByTask.ContainsKey($a.task_id)) {
            $attemptsByTask[$a.task_id] = @()
        }
        $attemptsByTask[$a.task_id] += $a
    }

    foreach ($taskId in $attemptsByTask.Keys) {
        $group = @($attemptsByTask[$taskId])
        if ($group.Count -le 1) { continue }

        $ordered = $group | Sort-Object -Property @{
            Expression = {
                try { [datetime]::Parse($_.updated_at) } catch { Get-Date 0 }
            }
            Descending = $true
        }
        $keeper = $ordered[0]
        $duplicates = $ordered | Select-Object -Skip 1

        foreach ($dup in $duplicates) {
            Write-Log "Duplicate attempt for task $($taskId.Substring(0,8)) — archiving $($dup.id.Substring(0,8)) (keeping $($keeper.id.Substring(0,8)))" -Level "WARN"
            if (-not $DryRun) {
                Archive-VKAttempt -AttemptId $dup.id | Out-Null
            }
            if ($script:TrackedAttempts.ContainsKey($dup.id)) {
                $tracked = $script:TrackedAttempts[$dup.id]
                if ($tracked) {
                    Clear-PendingFollowUp -Info $tracked -Reason "duplicate_attempt"
                }
                $script:TrackedAttempts.Remove($dup.id)
                $script:ProcessedAttemptIds.Add($dup.id) | Out-Null
                Save-ProcessedAttemptIds
            }
        }
    }

    # Remove attempts that disappeared from active list (archived)
    $activeIds = @($apiAttempts | ForEach-Object { $_.id })
    $toCheck = @($script:TrackedAttempts.Keys | Where-Object { $_ -notin $activeIds })
    foreach ($id in $toCheck) {
        $tracked = $script:TrackedAttempts[$id]
        if ($tracked) {
            Clear-PendingFollowUp -Info $tracked -Reason "attempt_archived"
        }
        Write-Log "Attempt $($id.Substring(0,8)) archived — removing from tracking" -Level "INFO"
        $script:TrackedAttempts.Remove($id)
    }

    $summaryKeys = @($script:AttemptSummaries.Keys)
    foreach ($id in $summaryKeys) {
        if ($id -notin $activeIds) {
            $script:AttemptSummaries.Remove($id)
        }
    }

    # Handle stale/idle attempts (no PR, idle beyond threshold) based on summaries
    foreach ($a in $apiAttempts) {
        $tracked = $script:TrackedAttempts[$a.id]
        if (-not $tracked) { continue }
        if ($tracked.status -ne "review") { continue }

        $summary = $summaryMap[$a.id]
        if (-not $summary) { continue }
        if ($summary.latest_process_status -ne "completed") { continue }

        $lastUpdate = Get-AttemptLastActivity -Summary $summary
        if (-not $lastUpdate) { continue }

        $idleMinutes = ((Get-Date) - $lastUpdate).TotalMinutes
        if ($idleMinutes -lt $IdleTimeoutMin) {
            $tracked.idle_detected_at = $null
            continue
        }

        if (-not $tracked.idle_detected_at) {
            # Anchor confirm timing to when the attempt crossed IdleTimeoutMin.
            $tracked.idle_detected_at = $lastUpdate.AddMinutes($IdleTimeoutMin)
        }

        $confirmMinutes = ((Get-Date) - $tracked.idle_detected_at).TotalMinutes
        if ($confirmMinutes -lt $IdleConfirmMin) {
            $remaining = [math]::Ceiling($IdleConfirmMin - $confirmMinutes)
            Write-Log "Attempt $($a.id.Substring(0,8)) idle ${IdleTimeoutMin}m+ — will confirm in ${remaining}m" -Level "WARN"
            continue
        }

        # ── Escalate long-idle review attempts ────────────────────────────
        # After 3x IdleTimeoutMin (180m by default), archive and reset task
        # so it can be re-attempted instead of sitting forever.
        $totalIdleMinutes = $idleMinutes
        $escalationThreshold = $IdleTimeoutMin * 3  # 180m default

        if ($totalIdleMinutes -ge $escalationThreshold) {
            Write-Log "Attempt $($a.id.Substring(0,8)) idle $([math]::Round($totalIdleMinutes))m (>= ${escalationThreshold}m threshold) — archiving stale review attempt" -Level "ERROR"
            if (-not $DryRun) {
                $archived = Try-ArchiveAttempt -AttemptId $a.id -AttemptObject $a
                if ($archived) {
                    $tracked.status = "archived"
                    $tracked.archived_reason = "idle_review_escalation"
                    Write-Log "Archived stale review attempt $($a.id.Substring(0,8)) — task will be re-attempted" -Level "OK"
                }
            }
        }
        else {
            # Not yet at escalation threshold — log warning and let Process-CompletedAttempts handle it
            $remaining = [math]::Ceiling($escalationThreshold - $totalIdleMinutes)
            Write-Log "Attempt $($a.id.Substring(0,8)) idle $([math]::Round($totalIdleMinutes))m — awaiting PR (will escalate in ${remaining}m)" -Level "WARN"
        }
    }

    # ── Stale running detection (stateless — crash-restart-safe) ───────────
    # Detect "running" attempts that have been stuck too long with no process
    # completion. Uses absolute time thresholds from VK data so detection
    # survives orchestrator restarts without needing in-memory state.
    #
    # Two paths:
    # 1. Setup-failure fast path: If VK never launched an agent process
    #    (latest_session_id and latest_process_status both null), the setup
    #    script failed or hung. Use shorter SetupTimeoutMin (default 30m).
    # 2. General stale: Agent ran but hasn't completed. Use StaleRunningTimeoutMin
    #    + IdleConfirmMin as combined absolute threshold.
    foreach ($a in $apiAttempts) {
        $tracked = $script:TrackedAttempts[$a.id]
        if (-not $tracked) { continue }
        if ($tracked.status -ne "running") { continue }

        $summary = $summaryMap[$a.id]

        # Determine how long this attempt has been "running" with no output.
        # Use the summary's process completion time if available, otherwise
        # fall back to the VK attempt updated_at timestamp (set when the
        # attempt was created or last modified by VK).
        $activityTime = $null

        if ($summary -and $summary.latest_process_completed_at) {
            try { $activityTime = ([datetimeoffset]::Parse($summary.latest_process_completed_at)).ToLocalTime().DateTime } catch { }
        }

        if (-not $activityTime -and $a.updated_at) {
            try { $activityTime = ([datetimeoffset]::Parse($a.updated_at)).ToLocalTime().DateTime } catch { }
        }

        if (-not $activityTime -and $tracked.updated_at) {
            try { $activityTime = ([datetimeoffset]::Parse($tracked.updated_at)).ToLocalTime().DateTime } catch { }
        }

        if (-not $activityTime) { continue }

        $staleMinutes = ((Get-Date) - $activityTime).TotalMinutes

        # ── Path 1: Setup-failure fast path ─────────────────────────────────
        # If no session and no process status, VK never launched an agent.
        # The setup script either failed or is hanging. Use shorter timeout
        # with no confirm window — there's nothing to confirm, no agent ran.
        $isSetupFailure = $summary -and
        (-not $summary.latest_session_id) -and
        (-not $summary.latest_process_status)

        if ($isSetupFailure) {
            if ($staleMinutes -lt $SetupTimeoutMin) {
                if ($staleMinutes -ge ($SetupTimeoutMin * 0.5)) {
                    Write-Log "Attempt $($a.id.Substring(0,8)) setup pending for $([math]::Round($staleMinutes))m (no session/process) — will archive at ${SetupTimeoutMin}m" -Level "WARN"
                }
                continue
            }

            Write-Log "Attempt $($a.id.Substring(0,8)) setup never completed ($([math]::Round($staleMinutes))m, no session/process) — archiving (branch: $($tracked.branch))" -Level "ERROR"
            if (-not $DryRun) {
                $archived = Try-ArchiveAttempt -AttemptId $a.id -AttemptObject $a
                if ($archived) {
                    try {
                        Update-VKTaskStatus -TaskId $tracked.task_id -Status "todo" | Out-Null
                        Write-Log "Reset task $($tracked.task_id.Substring(0,8)) to todo for reattempt (setup failed)" -Level "INFO"
                    }
                    catch {
                        Write-Log "Failed to reset task $($tracked.task_id.Substring(0,8)) status: $_" -Level "WARN"
                    }

                    if ($script:AgentWorkLoggerEnabled) {
                        try { Stop-AgentSession -AttemptId $a.id -CompletionStatus "setup_failed" } catch { }
                    }

                    Clear-PendingFollowUp -Info $tracked -Reason "setup_failed_archived"
                    $script:TrackedAttempts.Remove($a.id)
                    $script:ProcessedAttemptIds.Add($a.id) | Out-Null
                    Save-ProcessedAttemptIds
                }
            }
            continue
        }

        # ── Path 2: General stale running ───────────────────────────────────
        # Agent may have started but is stuck. Use absolute threshold with
        # built-in confirm window (StaleRunningTimeoutMin + IdleConfirmMin).
        # This is stateless — no in-memory timer that resets on restart.
        $archiveThreshold = $StaleRunningTimeoutMin + $IdleConfirmMin

        if ($staleMinutes -lt $StaleRunningTimeoutMin) { continue }

        if ($staleMinutes -lt $archiveThreshold) {
            $remaining = [math]::Ceiling($archiveThreshold - $staleMinutes)
            Write-Log "Attempt $($a.id.Substring(0,8)) stale-running for $([math]::Round($staleMinutes))m — will archive in ${remaining}m" -Level "WARN"
            continue
        }

        # Archive the zombie attempt and free the slot
        Write-Log "Attempt $($a.id.Substring(0,8)) stale-running for $([math]::Round($staleMinutes))m — archiving to free slot (branch: $($tracked.branch))" -Level "ERROR"
        if (-not $DryRun) {
            $archived = Try-ArchiveAttempt -AttemptId $a.id -AttemptObject $a
            if ($archived) {
                # Reset task to todo so it will be reattempted
                try {
                    Update-VKTaskStatus -TaskId $tracked.task_id -Status "todo" | Out-Null
                    Write-Log "Reset task $($tracked.task_id.Substring(0,8)) to todo for reattempt" -Level "INFO"
                }
                catch {
                    Write-Log "Failed to reset task $($tracked.task_id.Substring(0,8)) status: $_" -Level "WARN"
                }

                # ── Agent Work Logger: stop session ──
                if ($script:AgentWorkLoggerEnabled) {
                    try { Stop-AgentSession -AttemptId $a.id -CompletionStatus "stale_timeout" } catch { }
                }

                Clear-PendingFollowUp -Info $tracked -Reason "stale_running_archived"
                $script:TrackedAttempts.Remove($a.id)
                $script:ProcessedAttemptIds.Add($a.id) | Out-Null
                Save-ProcessedAttemptIds
            }
        }
    }

    foreach ($a in $apiAttempts) {
        $tracked = $script:TrackedAttempts[$a.id]
        if (-not $tracked) { continue }
        if (-not $tracked.context_recovery_pending) { continue }
        $summary = $summaryMap[$a.id]
        if (-not $summary) { continue }
        if ($summary.latest_process_status -eq "running") { continue }
        $null = Try-RecoverContextWindow -AttemptId $a.id -Info $tracked
    }
}

function Prune-CompletedTaskWorkspaces {
    <#
    .SYNOPSIS Clean up workspaces and worktrees for completed/cancelled tasks.
    .DESCRIPTION
    Removes VK workspace directories and prunes git worktrees for tasks that are
    already done or cancelled to prevent zombie workspaces and stale worktree errors.
    #>

    # Get all completed/cancelled tasks
    $completedTasks = Get-VKTasks -Status "done"
    $cancelledTasks = Get-VKTasks -Status "cancelled"
    $allDoneTasks = @($completedTasks) + @($cancelledTasks)

    if ($allDoneTasks.Count -eq 0) {
        Write-Log "No completed/cancelled tasks to clean up" -Level "DEBUG"
        return
    }

    Write-Log "Checking $($allDoneTasks.Count) completed/cancelled tasks for workspace cleanup..." -Level "DEBUG"

    # Prune stale git worktrees first (this cleans up orphaned metadata)
    try {
        $pruneOutput = git worktree prune -v 2>&1
        if ($pruneOutput -and $pruneOutput -ne "") {
            Write-Log "Pruned stale git worktrees: $pruneOutput" -Level "INFO"
        }
    }
    catch {
        Write-Log "Failed to prune git worktrees: $_" -Level "WARN"
    }

    # Clean up VK workspace directories for completed tasks
    $tempRoot = Get-EnvFallback -Name "TEMP"
    if (-not $tempRoot) { $tempRoot = Get-EnvFallback -Name "TMP" }
    if (-not $tempRoot) { $tempRoot = [IO.Path]::GetTempPath() }
    $vkWorkspaceBase = Join-Path $tempRoot "vibe-kanban\worktrees"
    if (-not (Test-Path $vkWorkspaceBase)) {
        Write-Log "VK workspace directory not found: $vkWorkspaceBase" -Level "DEBUG"
        return
    }

    $cleanedCount = 0
    foreach ($task in $allDoneTasks) {
        if (-not $task.id) { continue }

        # VK workspace pattern: <taskid-prefix>-<slug>/
        $taskPrefix = $task.id.Substring(0, [Math]::Min(4, $task.id.Length))
        $workspaceDirs = Get-ChildItem -Path $vkWorkspaceBase -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$taskPrefix-*" }

        foreach ($dir in $workspaceDirs) {
            $fullPath = $dir.FullName
            Write-Log "Removing workspace for completed task $($task.id.Substring(0,8)): $($dir.Name)" -Level "INFO"

            if (-not $DryRun) {
                try {
                    Remove-Item -Path $fullPath -Recurse -Force -ErrorAction Stop
                    $cleanedCount++
                }
                catch {
                    Write-Log "Failed to remove workspace $($dir.Name): $_" -Level "WARN"
                }
            }
            else {
                Write-Log "[DRY-RUN] Would remove: $fullPath" -Level "INFO"
                $cleanedCount++
            }
        }
    }

    if ($cleanedCount -gt 0) {
        Write-Log "Cleaned up $cleanedCount workspace(s) for completed/cancelled tasks" -Level "OK"

        # Prune worktrees again after cleanup to remove references
        try {
            git worktree prune -v 2>&1 | Out-Null
        }
        catch {
            # Silently ignore - already logged above
        }
    }
}

# ── Anomaly Signal Processing (v0.14.7) ──────────────────────────────────────
function Process-AnomalySignals {
    <#
    .SYNOPSIS Read anomaly signals written by the monitor's anomaly detector
    and translate kill-worthy events into recovery actions for tracked attempts.
    #>
    if (-not (Test-Path $script:AnomalySignalPath)) { return }

    try {
        $raw = Get-Content $script:AnomalySignalPath -Raw -ErrorAction SilentlyContinue
        if (-not $raw) { return }
        $signals = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
        if (-not $signals -or @($signals).Count -eq 0) { return }

        # Clear the file immediately to avoid re-processing
        Set-Content $script:AnomalySignalPath -Value "[]" -Force

        foreach ($signal in $signals) {
            $shortId = $signal.shortId
            if (-not $shortId) { continue }

            # Find matching tracked attempt
            $matched = $null
            foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
                if ($entry.Key.StartsWith($shortId) -or ($entry.Value.branch -and $entry.Value.branch -match $shortId)) {
                    $matched = $entry
                    break
                }
            }

            if (-not $matched) {
                Write-Log "Anomaly signal for $shortId — no matching tracked attempt" -Level "WARN"
                continue
            }

            $attemptId = $matched.Key
            $info = $matched.Value

            Write-Log "Anomaly signal: $($signal.type) ($($signal.severity)) for $($info.branch) — action=$($signal.action)" -Level "WARN"

            # For kill/restart actions, handle recovery based on attempt status
            if ($signal.action -in @("kill", "restart")) {
                if ($info.status -in @("review", "error")) {
                    $info.status = "error"
                    $info.error_notified = $true
                    $msg = "The anomaly detector flagged this task ($($signal.type): $($signal.message)). Starting a fresh session to retry."
                    $info.force_new_session = $true
                    $null = Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $msg -Reason "anomaly_recovery"
                }
                elseif ($info.status -eq "running") {
                    # Kill signal on a running process — the anomaly detector
                    # already decided this process should die (threshold
                    # exceeded). Act immediately regardless of severity level.
                    # A HIGH-severity kill is just as actionable as CRITICAL —
                    # the detector differentiates severity for notification
                    # purposes, but action="kill" means KILL.
                    $sevLabel = if ($signal.severity -eq "CRITICAL") { "CRITICAL" } else { "SEVERE" }
                    Write-Log "$sevLabel anomaly ($($signal.type)) for running attempt $($attemptId.Substring(0,8)) — archiving + retrying (action=$($signal.action))" -Level "WARN"
                    $info.status = "error"
                    $info.error_notified = $true
                    $info.force_new_session = $true
                    $info.anomaly_killed = $true
                    $msg = "$sevLabel anomaly: $($signal.type) — $($signal.message). Archiving and retrying with a fresh session."
                    $null = Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $msg -Reason "anomaly_kill"
                }
            }
        }
    }
    catch {
        Write-Log "Process-AnomalySignals error: $($_.Exception.Message)" -Level "WARN"
    }
}

# ── Codex SDK Takeover (v0.14.6) ─────────────────────────────────────────────
function Process-CodexTakeoverJobs {
    <#
    .SYNOPSIS After N failed follow-up attempts, take over with Codex SDK CLI directly.
    Runs `codex exec --sandbox danger-full-access` against the worktree.
    #>
    foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
        $attemptId = $entry.Key
        $info = $entry.Value

        # Only consider failed tasks that have exceeded the takeover threshold
        if ($info.status -notin @("error", "review", "manual_review")) { continue }

        $taskKey = if ($info.task_id) { $info.task_id } else { $attemptId }
        $followUpCount = if ($script:TaskFollowUpCounts.ContainsKey($taskKey)) {
            $script:TaskFollowUpCounts[$taskKey]
        }
        else { 0 }

        if ($followUpCount -lt $script:CODEX_TAKEOVER_THRESHOLD) { continue }

        # Check if we already have an active takeover job
        if ($script:CodexTakeoverJobs.ContainsKey($attemptId)) {
            $job = $script:CodexTakeoverJobs[$attemptId]
            if ($job.State -eq "Running") { continue }

            # Job finished — check result
            $output = Receive-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
            $script:CodexTakeoverJobs.Remove($attemptId)

            Write-Log "Codex takeover finished for $($info.branch)" -Level "OK"
            $info.status = "review"
            $info.codex_takeover_completed = $true
            continue
        }

        # Check if Codex CLI is available
        $codexPath = Get-Command "codex" -ErrorAction SilentlyContinue
        if (-not $codexPath) {
            Write-Log "Codex CLI not available — cannot takeover $($info.branch)" -Level "WARN"
            continue
        }

        # Get worktree path for this branch
        $worktreePath = Get-WorktreePathForBranch -Branch $info.branch
        if (-not $worktreePath -or -not (Test-Path $worktreePath)) {
            Write-Log "No worktree for $($info.branch) — cannot takeover" -Level "WARN"
            continue
        }

        # Get task description for the prompt
        $taskDesc = ""
        if ($info.task_description_cached) {
            $taskDesc = $info.task_description_cached
        }
        elseif ($info.name) {
            $taskDesc = $info.name
        }

        $takeoverPrompt = @"
You are taking over a task that failed after $followUpCount attempts.
Task: $taskDesc
Branch: $($info.branch)

COMPLETE THIS TASK END-TO-END:
1. Check what has been done so far (git log, git status, existing code)
2. Implement all remaining changes
3. Write or fix tests
4. Run formatting (gofmt, prettier as needed)
5. Commit with conventional commit message
6. Push to origin

Do NOT ask for confirmation. Just do it.
"@

        Write-Log "Starting Codex CLI takeover for $($info.branch) (attempt $followUpCount/$($script:CODEX_TAKEOVER_THRESHOLD) threshold reached)" -Level "ACTION"

        if (-not $DryRun) {
            $job = Start-Job -ScriptBlock {
                param($codexExe, $prompt, $workDir)
                & $codexExe exec --sandbox "danger-full-access" -C $workDir --skip-git-repo-check $prompt 2>&1
            } -ArgumentList @($codexPath.Source, $takeoverPrompt, $worktreePath)

            $script:CodexTakeoverJobs[$attemptId] = $job
            $info.codex_takeover_started = $true
            $info.codex_takeover_at = Get-Date
        }
    }
}

function Process-CompletedAttempts {
    <#
    .SYNOPSIS Check tracked attempts for PR status and handle merging.
    #>
    if (Test-GithubCooldown) { return }
    $processed = @()

    foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
        $attemptId = $entry.Key
        $info = $entry.Value

      try {

        # Skip already-completed or manual review
        if ($info.status -in @("merged", "done", "manual_review")) { continue }

        if ($info.pending_followup) {
            $pending = $info.pending_followup
            if ($pending.new_session) {
                $null = Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $pending.message -Reason $pending.reason
            }
            else {
                $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $pending.message -Reason $pending.reason
            }
        }

        $branch = $info.branch
        if (-not $branch) { continue }

        if ($info.status -eq "running" -or $info.last_process_status -eq "running") {
            continue
        }

        # Check for PR
        $pr = Get-PRForBranch -Branch $branch
        if (Test-GithubRateLimit) { return }
        if (-not $pr) {
            if ($info.status -in @("review", "error")) {
                if (-not (Test-RemoteBranchExists -Branch $branch)) {
                    Write-Log "No remote branch for $branch — checking if already merged" -Level "INFO"

                    # ── Check if branch was already merged into base (prevents infinite retry) ──
                    if (Test-BranchMergedIntoBase -Branch $branch) {
                        Write-Log "Branch $branch was already merged into base — completing task" -Level "OK"
                        $info.status = "done"
                        $info.already_merged = $true
                        $script:TasksCompleted++
                        $script:TotalTasksCompleted++
                        Save-SuccessMetrics
                        try {
                            if ($info.task_id) {
                                Update-VKTaskStatus -TaskId $info.task_id -Status "done" | Out-Null
                                Write-Log "Marked already-merged task $($info.task_id.Substring(0,8)) as done" -Level "OK"
                            }

                            # Archive the attempt (handles already-archived cases gracefully)
                            $attempt = $apiAttempts | Where-Object { $_.id -eq $attemptId } | Select-Object -First 1
                            Try-ArchiveAttempt -AttemptId $attemptId -AttemptObject $attempt | Out-Null
                        }
                        catch {
                            Write-Log "Failed to complete already-merged task $($info.task_id.Substring(0,8)): $_" -Level "WARN"
                        }
                        $processed += $attemptId
                        continue
                    }

                    # ── Check if task description says it's already completed ──
                    if ($info.task_id -and (Test-TaskDescriptionAlreadyComplete -TaskId $info.task_id)) {
                        Write-Log "Task $($info.task_id.Substring(0,8)) description says already completed — archiving attempt" -Level "OK"
                        $info.status = "done"
                        $info.description_complete = $true
                        try {
                            Update-VKTaskStatus -TaskId $info.task_id -Status "done" | Out-Null
                            $attempt = $apiAttempts | Where-Object { $_.id -eq $attemptId } | Select-Object -First 1
                            Try-ArchiveAttempt -AttemptId $attemptId -AttemptObject $attempt | Out-Null
                        }
                        catch {
                            Write-Log "Failed to complete description-complete task $($info.task_id.Substring(0,8)): $_" -Level "WARN"
                        }
                        $processed += $attemptId
                        continue
                    }

                    $summary = $script:AttemptSummaries[$attemptId]
                    $failure = Get-AttemptFailureCategory -Summary $summary -Info $info
                    $recentFollowup = $false
                    if ($info.last_followup_at) {
                        $recentFollowup = (((Get-Date) - $info.last_followup_at).TotalMinutes -lt 10)
                    }

                    # ── Handle NO_CHANGES response (agent says task needs no code changes) ────
                    if ($failure.category -eq "no_changes") {
                        Write-Log "Agent responded NO_CHANGES for $branch — task genuinely requires no code changes" -Level "INFO"
                        $info.status = "done"
                        $info.no_changes = $true
                        $script:TasksFailed++
                        Save-SuccessMetrics
                        $attempt = $apiAttempts | Where-Object { $_.id -eq $attemptId } | Select-Object -First 1
                        Try-ArchiveAttempt -AttemptId $attemptId -AttemptObject $attempt | Out-Null
                        $processed += $attemptId
                        continue
                    }

                    if (-not $recentFollowup) {
                        if ($failure.category -in @("context_window", "model_error")) {
                            $count = Increment-TaskRetryCount -TaskId $info.task_id -Category $failure.category
                            $msg = if ($failure.category -eq "model_error") {
                                Get-ModelErrorRecoveryMessage -Info $info
                            }
                            else {
                                Get-ContextRecoveryMessage -Info $info
                            }
                            if ($count -ge 2) {
                                $msg = "$msg`n`nIf this fails again or there are no changes, reply NO_CHANGES so we can mark it for manual review."
                            }
                            $info.force_new_session = $true
                            $null = Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $msg -Reason "context_window_recovery" -IncludeTaskContext:$false
                            $info.push_notified = $true
                            continue
                        }

                        if ($failure.category -in @("api_key", "agent_failed")) {
                            $count = Increment-TaskRetryCount -TaskId $info.task_id -Category $failure.category
                            if ($count -ge 2) {
                                $msg = "Detected a failure (${failure.category}). Starting a fresh session now. Please retry your task. If it fails again or there are no changes, reply NO_CHANGES so we can mark it for manual review."
                                $null = Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $msg -Reason "retry_new_session"
                            }
                            else {
                                $msg = "Detected a failure (${failure.category}). Please retry your task. If it fails again, I will start a fresh session."
                                $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $msg -Reason "retry_task"
                            }
                            $info.push_notified = $true
                            continue
                        }

                        # Check if this is a fresh task (0 commits) or crashed task (has commits)
                        $commitsAhead = Get-CommitsAhead -Branch $branch
                        if ($commitsAhead -eq 0) {
                            # Fresh task: branch exists locally but has no work. Start fresh.
                            Write-Log "Branch $branch has 0 commits vs base — treating as fresh task, starting from scratch" -Level "INFO"
                            $count = Increment-TaskRetryCount -TaskId $info.task_id -Category "fresh_task_restart"
                            if ($count -ge 2) {
                                # Even fresh restart failed twice — mark for manual review
                                Write-Log "Fresh task restart failed $count times for $($info.task_id) — marking for manual review" -Level "WARN"
                                $info.status = "manual_review"
                                $info.fresh_task_failed = $true
                                $script:TasksFailed++
                                Save-SuccessMetrics
                                $attempt = $apiAttempts | Where-Object { $_.id -eq $attemptId } | Select-Object -First 1
                                Try-ArchiveAttempt -AttemptId $attemptId -AttemptObject $attempt | Out-Null
                                $processed += $attemptId
                                continue
                            }
                            # Start fresh session with original task prompt (no "check git status" nonsense)
                            $freshMsg = "This task has no commits yet. Please implement the task completely from scratch — read the task description carefully, implement all required changes, write tests, commit with a conventional commit message, and push to origin."
                            $null = Try-SendFollowUpNewSession -AttemptId $attemptId -Info $info -Message $freshMsg -Reason "fresh_task_restart" -IncludeTaskContext:$true
                            $info.push_notified = $true
                            continue
                        }
                        elseif ($commitsAhead -gt 0) {
                            # Has commits locally but not pushed — push directly via CLI (never ask agent)
                            Write-Log "Branch $branch has $commitsAhead commit(s) but remote is missing — pushing via CLI" -Level "ACTION"
                            $worktreePath = Get-WorktreePathForBranch -Branch $branch
                            $pushSuccess = $false
                            if ($worktreePath) {
                                try {
                                    $pushOut = git -C $worktreePath push -u origin $branch 2>&1
                                    if ($LASTEXITCODE -eq 0) {
                                        $pushSuccess = $true
                                        Write-Log "CLI push succeeded for $branch ($commitsAhead commits)" -Level "OK"
                                    }
                                    else {
                                        # Try force-with-lease as fallback
                                        $pushOut2 = git -C $worktreePath push -u origin $branch --force-with-lease --no-verify 2>&1
                                        if ($LASTEXITCODE -eq 0) {
                                            $pushSuccess = $true
                                            Write-Log "CLI push (force-with-lease, no-verify) succeeded for $branch" -Level "OK"
                                        }
                                        else {
                                            Write-Log "CLI push failed for $branch — $pushOut2" -Level "WARN"
                                        }
                                    }
                                }
                                catch {
                                    Write-Log "CLI push threw for $branch — $($_.Exception.Message)" -Level "WARN"
                                }
                            }
                            else {
                                Write-Log "No worktree found for $branch — cannot push via CLI" -Level "WARN"
                            }

                            if ($pushSuccess) {
                                # Branch is now upstream — create PR automatically
                                $title = if ($info.name) { $info.name } else { "Automated task PR" }
                                $created = Create-PRForBranchSafe -Branch $branch -Title $title -Body "Automated PR created by ve-orchestrator (CLI push)"
                                if (Test-GithubRateLimit) { return }
                                if ($created -and $created -ne "no_commits") {
                                    Write-Log "PR created for $branch after CLI push" -Level "OK"
                                    $pr = Get-PRForBranch -Branch $branch
                                    if ($pr) { $info.pr_number = $pr.number }
                                }
                                elseif ($created -eq "no_commits") {
                                    Write-Log "Branch $branch pushed but has no diff vs base — marking manual_review" -Level "WARN"
                                    $info.status = "manual_review"
                                    $info.no_commits = $true
                                }
                            }
                            else {
                                # CLI push failed — mark for manual review instead of asking agent
                                $count = Increment-TaskRetryCount -TaskId $info.task_id -Category "push_failed"
                                if ($count -ge 2) {
                                    Write-Log "CLI push failed $count times for $branch — marking manual_review" -Level "WARN"
                                    $info.status = "manual_review"
                                    $info.push_failed = $true
                                    $script:TasksFailed++
                                    Save-SuccessMetrics
                                }
                                else {
                                    Write-Log "CLI push failed for $branch — will retry next cycle" -Level "INFO"
                                }
                            }
                            $info.push_notified = $true
                            continue
                        }
                        else {
                            # commitsAhead == -1 (branch doesn't exist locally)
                            # Could be an already-merged task where local ref was cleaned up
                            if (Test-BranchMergedIntoBase -Branch $branch) {
                                Write-Log "Branch $branch doesn't exist locally but was merged into base — completing task" -Level "OK"
                                $info.status = "done"
                                $info.already_merged = $true
                                $script:TasksCompleted++
                                $script:TotalTasksCompleted++
                                Save-SuccessMetrics
                                try {
                                    if ($info.task_id) {
                                        Update-VKTaskStatus -TaskId $info.task_id -Status "done" | Out-Null
                                    }
                                    $attempt = $apiAttempts | Where-Object { $_.id -eq $attemptId } | Select-Object -First 1
                                    Try-ArchiveAttempt -AttemptId $attemptId -AttemptObject $attempt | Out-Null
                                }
                                catch {
                                    Write-Log "Failed to complete already-merged task: $_" -Level "WARN"
                                }
                                $processed += $attemptId
                                continue
                            }
                            Write-Log "Branch $branch doesn't exist locally despite being tracked — this is unexpected" -Level "ERROR"
                            $info.status = "manual_review"
                            $info.branch_missing = $true
                            $script:TasksFailed++
                            Save-SuccessMetrics
                            $processed += $attemptId
                            continue
                        }
                    }
                    continue
                }
                Write-Log "No PR for $branch — creating PR" -Level "ACTION"
                if (-not $DryRun) {
                    $title = if ($info.name) { $info.name } else { "Automated task PR" }
                    $created = Create-PRForBranchSafe -Branch $branch -Title $title -Body "Automated PR created by ve-orchestrator"
                    if (Test-GithubRateLimit) { return }
                    if ($created -eq "no_commits") {
                        $info.no_commits_retries = ($info.no_commits_retries ?? 0) + 1
                        Write-Log "Branch $branch has no commits vs base (retry $($info.no_commits_retries)/2)" -Level "WARN"

                        if ($info.no_commits_retries -ge 2) {
                            # Stop looping — archive the attempt and move on
                            Write-Log "Branch ${branch}: no_commits after $($info.no_commits_retries) retries — archiving attempt" -Level "WARN"
                            $info.status = "done"
                            $info.no_commits = $true
                            $script:TasksFailed++
                            Save-SuccessMetrics
                            $attempt = $apiAttempts | Where-Object { $_.id -eq $attemptId } | Select-Object -First 1
                            Try-ArchiveAttempt -AttemptId $attemptId -AttemptObject $attempt | Out-Null
                            $processed += $attemptId
                            continue
                        }

                        $info.status = "manual_review"
                        $info.no_commits = $true
                        $script:TasksFailed++
                        Save-SuccessMetrics
                        $msg = "Branch $branch has no commits compared to base. Please COMPLETE the assigned task: implement the code changes, write tests, commit, and push. If the task genuinely requires no code changes, reply NO_CHANGES."
                        $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $msg -Reason "no_commits"
                        continue
                    }
                    if (-not $created) { continue }
                    $pr = Get-PRForBranch -Branch $branch
                    if (Test-GithubRateLimit) { return }
                    if (-not $pr) { continue }
                }
                else {
                    Write-Log "[DRY-RUN] Would create PR for $branch" -Level "ACTION"
                    continue
                }
            }
            else {
                # No PR yet — agent might still be working or PR not created
                continue
            }
        }

        $info.pr_number = $pr.number

        $copilotState = Apply-CopilotStateToInfo -Info $info -PRNumber $pr.number

        # Check if already merged
        if ($pr.state -eq "MERGED" -or $pr.mergedAt) {
            Write-Log "PR #$($pr.number) for $branch is MERGED" -Level "OK"
            Clear-PendingFollowUp -Info $info -Reason "pr_merged"
            Remove-CopilotPRState -PRNumber $pr.number
            $info.status = "merged"
            Complete-Task -AttemptId $attemptId -TaskId $info.task_id -PRNumber $pr.number
            $processed += $attemptId
            continue
        }

        if ($pr.state -eq "CLOSED") {
            Write-Log "PR #$($pr.number) for $branch is CLOSED — clearing queued follow-ups" -Level "WARN"
            Clear-PendingFollowUp -Info $info -Reason "pr_closed"
            Remove-CopilotPRState -PRNumber $pr.number
            $info.status = "review"
            continue
        }

        $copilotState = Get-CopilotPRState -PRNumber $pr.number
        if ($copilotState -and -not $copilotState.completed) {
            Write-Log "PR #$($pr.number) has Copilot fix pending — deferring agent follow-ups" -Level "INFO"
        }

        # PR exists but not merged — check CI
        $prDetails = Get-PRDetails -PRNumber $pr.number
        if (Test-GithubRateLimit) { return }
        $mergeState = if ($prDetails -and $prDetails.mergeStateStatus) { $prDetails.mergeStateStatus } else { "UNKNOWN" }

        if ($mergeState -in @("DIRTY", "CONFLICTING")) {
            Write-Log "PR #$($pr.number) has merge conflicts ($mergeState)" -Level "WARN"
            $info.status = "review"

            # ── Try direct rebase first (uses persistent disk-based cooldown) ────────
            # The old in-memory flag ($info.conflict_rebase_attempted) was lost on restart.
            # Now we use Test-RebaseCooldown which persists to .cache/ve-rebase-cooldown.json.
            if (-not (Test-RebaseCooldown -Branch $branch)) {
                Set-RebaseCooldown -Branch $branch -CooldownMinutes 30
                $rebaseBase = Resolve-PRBaseBranch -Info $info -PRDetails $prDetails
                Write-Log "Attempting direct rebase for conflicting PR #$($pr.number) onto $rebaseBase" -Level "ACTION"
                $rebaseOk = Invoke-DirectRebase -Branch $branch -BaseBranch $rebaseBase -AttemptId $attemptId
                if ($rebaseOk -eq $true) {
                    Write-Log "Direct rebase resolved conflicts for PR #$($pr.number)" -Level "OK"
                    $info.conflict_notified = $false
                    continue  # Re-check merge state next cycle
                }
                if ($rebaseOk -eq "sdk_needed") {
                    # Merge is left in progress for the monitor's SDK resolver
                    # Set a short cooldown so the SDK resolver gets a chance before @copilot
                    Write-Log "Merge left in progress for SDK resolver — PR #$($pr.number)" -Level "INFO"
                    $info.sdk_resolution_pending = $true
                    $info.sdk_resolution_started = (Get-Date).ToString("o")
                    continue  # Skip @copilot notification — let SDK resolver attempt first
                }
                Write-Log "Direct rebase failed for PR #$($pr.number) — proceeding to notification" -Level "WARN"
            }

            # ── Guard: if SDK resolution was recently requested, give it time ────────
            if ($info.sdk_resolution_pending) {
                $sdkStart = [datetime]::Parse($info.sdk_resolution_started)
                $sdkElapsed = (Get-Date) - $sdkStart
                if ($sdkElapsed.TotalMinutes -lt 15) {
                    Write-Log "SDK resolver active for PR #$($pr.number) ($([int]$sdkElapsed.TotalMinutes)m elapsed) — skipping @copilot" -Level "INFO"
                    continue
                }
                Write-Log "SDK resolver timed out for PR #$($pr.number) ($([int]$sdkElapsed.TotalMinutes)m) — falling back to @copilot" -Level "WARN"
                $info.sdk_resolution_pending = $false
            }

            if (-not $info.conflict_notified) {
                # Guard FIRST: never duplicate @copilot — survives orchestrator restarts
                if ((Test-PRHasCopilotComment -PRNumber $pr.number) -or (Test-CopilotPRClosed -PRNumber $pr.number)) {
                    Write-Log "Skipping conflict notification for PR #$($pr.number) — @copilot already mentioned or sub-PR was closed" -Level "WARN"
                    $info.conflict_notified = $true
                    continue
                }

                $rateLimitHit = $null
                if ($script:CopilotCloudDisableOnRateLimit) {
                    $rateLimitHit = Test-CopilotRateLimitComment -PRNumber $pr.number
                    if ($rateLimitHit -and $rateLimitHit.hit) {
                        Disable-CopilotCloud -Minutes $script:CopilotRateLimitCooldownMin -Reason "copilot_rate_limit_detected"
                    }
                }

                if (Test-CopilotCloudDisabled -or ($rateLimitHit -and $rateLimitHit.hit)) {
                    $cooldown = $script:CopilotRateLimitCooldownMin
                    $message = @"
Merge conflict detected for PR #$($pr.number).

Copilot cloud is disabled (rate limit detected). Please rebase or resolve conflicts on branch `$branch`, then push updated changes.
Cooldown: $cooldown minutes. Resolution mode: $($script:CopilotLocalResolution).
"@
                    $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $message.Trim() -Reason "merge_conflict_local"
                    $info.conflict_notified = $true
                    continue
                }

                $body = @"
@copilot Merge conflict detected for PR #$($pr.number).

Please rebase or resolve conflicts on branch ``$branch``, then push updated changes.
"@
                if (-not $DryRun) {
                    Add-PRComment -PRNumber $pr.number -Body $body | Out-Null
                    Add-RecentItem -ListName "CopilotRequests" -Item @{
                        pr_number   = $pr.number
                        pr_title    = $pr.title
                        pr_url      = $pr.url
                        reason      = "merge_conflict"
                        occurred_at = (Get-Date).ToString("o")
                    }
                }
                $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $body.Trim() -Reason "merge_conflict"
                $info.conflict_notified = $true
            }
            continue
        }

        $baseBranch = if ($prDetails -and $prDetails.baseRefName) { $prDetails.baseRefName } else { $script:VK_TARGET_BRANCH }
        if ($baseBranch -like "origin/*") { $baseBranch = $baseBranch.Substring(7) }
        $checkStatus = Get-PRRequiredCheckStatus -PRNumber $pr.number -BaseBranch $baseBranch
        if (Test-GithubRateLimit) { return }
        Write-Log "PR #$($pr.number) ($branch): CI=$checkStatus" -Level "INFO"

        switch ($checkStatus) {
            "passing" {
                Write-Log "CI passing for PR #$($pr.number) — merging..." -Level "ACTION"
                if (-not $DryRun) {
                    $mergeResult = Merge-PRWithFallback -PRNumber $pr.number -ForceAdmin:$UseAdminMerge
                    if (Test-GithubRateLimit) { return }
                    if ($mergeResult.merged) {
                        $info.status = "merged"
                        Complete-Task -AttemptId $attemptId -TaskId $info.task_id -PRNumber $pr.number
                        $processed += $attemptId
                    }
                    else {
                        $reason = if ($mergeResult.reason) { $mergeResult.reason } else { "Unknown merge error" }
                        $failure = Get-MergeFailureInfo -PRNumber $pr.number -Reason $reason
                        if (Test-GithubRateLimit) { return }
                        Write-Log "Merge failed for PR #$($pr.number) ($($failure.summary))" -Level "WARN"

                        $retryResult = $null
                        if ($failure.category -notin @("conflict", "review_required", "draft", "blocked", "rate_limit")) {
                            if (-not (Start-InterruptibleSleep -Seconds 2 -Reason "merge-retry")) { break }
                            $retryResult = Merge-PRWithFallback -PRNumber $pr.number -ForceAdmin:$UseAdminMerge
                            if (Test-GithubRateLimit) { return }
                            if ($retryResult.merged) {
                                $info.status = "merged"
                                Complete-Task -AttemptId $attemptId -TaskId $info.task_id -PRNumber $pr.number
                                $processed += $attemptId
                                break
                            }
                            $reason = if ($retryResult.reason) { $retryResult.reason } else { $reason }
                            $failure = Get-MergeFailureInfo -PRNumber $pr.number -Reason $reason
                            if (Test-GithubRateLimit) { return }
                            Write-Log "Retry merge failed for PR #$($pr.number) ($($failure.summary))" -Level "WARN"
                        }

                        if ($failure.category -eq "draft") {
                            Write-Log "Marking PR #$($pr.number) ready (draft)" -Level "ACTION"
                            if (-not $DryRun) {
                                $null = Mark-PRReady -PRNumber $pr.number
                            }
                        }

                        if ($failure.category -eq "behind" -and $attemptId -and -not $info.rebase_requested) {
                            $rebaseBase = Resolve-PRBaseBranch -Info $info -PRDetails $prDetails
                            Write-Log "Requesting direct rebase for PR #$($pr.number) onto $rebaseBase (attempt $($attemptId.Substring(0,8)))" -Level "ACTION"
                            $info.rebase_requested = $true
                            $rebaseOk = Invoke-DirectRebase -Branch $branch -BaseBranch $rebaseBase -AttemptId $attemptId
                            if ($rebaseOk) {
                                $info.rebase_requested = $false  # Reset so rebase can be retried if still behind
                            }
                        }

                        $info.merge_failures_total = [int]($info.merge_failures_total ?? 0) + 1
                        $info.merge_failure_cycles = [int]($info.merge_failure_cycles ?? 0) + 1
                        $info.last_merge_failure_reason = $reason
                        $info.last_merge_failure_category = $failure.category
                        $info.last_merge_failure_at = Get-Date
                        if (-not $info.manual_review_notified -and $info.merge_failure_cycles -ge 2) {
                            $info.last_merge_notify_at = Get-Date
                            $info.manual_review_notified = $true
                            $info.status = "manual_review"
                            if (-not $DryRun) {
                                Update-VKTaskStatus -TaskId $info.task_id -Status "inreview" | Out-Null
                            }
                            Write-Log "Merge notify: PR #$($pr.number) stage=manual_review category=$($failure.category) action=$($failure.action) reason=$reason" -Level "WARN"
                        }

                        if ($UseAutoMerge) {
                            $enabled = Merge-PR -PRNumber $pr.number -AutoMerge
                            if (Test-GithubRateLimit) { return }
                            if (-not $enabled) {
                                $autoErr = Get-VKLastGithubError
                                $autoReason = if ($autoErr -and $autoErr.message) { $autoErr.message } else { "Unknown auto-merge error" }
                                Write-Log "Auto-merge enable failed: $autoReason" -Level "WARN"
                            }
                        }
                        if (-not $info.merge_failed_notified -and $failure.category -notin @("behind", "base_changed", "rate_limit")) {
                            $msg = "Merge failed for PR #$($pr.number). Reason: $reason. ($($failure.summary))"
                            $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $msg -Reason "merge_failed"
                            $info.merge_failed_notified = $true
                        }
                    }
                }
                else {
                    Write-Log "[DRY-RUN] Would merge PR #$($pr.number)" -Level "ACTION"
                }
                $info.ci_notified = $false
            }
            "pending" {
                # CI still running — enable auto-merge if not already
                Write-Log "CI pending for PR #$($pr.number) — enabling auto-merge" -Level "INFO"
                if (-not $DryRun) {
                    if ($UseAutoMerge) {
                        $enabled = Enable-AutoMerge -PRNumber $pr.number
                        if (Test-GithubRateLimit) { return }
                        if (-not $enabled) {
                            $mergeErr = Get-VKLastGithubError
                            $reason = if ($mergeErr -and $mergeErr.message) { $mergeErr.message } else { "Unknown auto-merge error" }
                            Write-Log "Auto-merge enable failed: $reason" -Level "WARN"
                        }
                    }
                }
            }
            "failing" {
                Write-Log "CI FAILING for PR #$($pr.number) — needs attention" -Level "WARN"
                # Don't block the slot — the agent or a human needs to fix this
                # We mark it so we don't keep retrying every cycle
                $info.status = "review"

                # Global guard: if @copilot was already mentioned on this PR, do not
                # invoke Copilot cloud again (survives orchestrator restarts where
                # in-memory flags like copilot_fix_requested are lost).
                $alreadyMentioned = (Test-PRHasCopilotComment -PRNumber $pr.number) -or (Test-CopilotPRClosed -PRNumber $pr.number)

                $checks = Get-PRChecksDetail -PRNumber $pr.number
                if (Test-GithubRateLimit) { return }
                if (-not $checks) {
                    $checks = @()
                }
                $summary = Format-PRCheckFailures -Checks $checks
                $body = @"
CI is failing for PR #$($pr.number).

$summary
"@

                if ($script:CopilotCloudDisableOnRateLimit) {
                    $rateLimitHit = Test-CopilotRateLimitComment -PRNumber $pr.number
                    if ($rateLimitHit -and $rateLimitHit.hit) {
                        Disable-CopilotCloud -Minutes $script:CopilotRateLimitCooldownMin -Reason "copilot_rate_limit_detected"
                    }
                }

                if (Test-CopilotCloudDisabled) {
                    if (-not $info.local_fix_requested) {
                        Write-Log "Copilot cloud disabled — routing CI fix to local agent" -Level "WARN"
                        $localBody = @"
CI is failing for PR #$($pr.number).

$summary
"@
                        $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $localBody.Trim() -Reason "ci_failing_local"
                        $info.local_fix_requested = $true
                    }
                    break
                }

                if ($copilotState) {
                    $info.copilot_fix_requested = $true
                    break
                }

                if (-not $info.copilot_fix_pr_number) {
                    $existingCopilot = Find-CopilotFixPR -OriginalPRNumber $pr.number
                    if ($existingCopilot) {
                        if ($script:CopilotCloudDisableOnRateLimit) {
                            $copilotRateLimit = Test-CopilotRateLimitComment -PRNumber $existingCopilot.number
                            if ($copilotRateLimit -and $copilotRateLimit.hit) {
                                Disable-CopilotCloud -Minutes $script:CopilotRateLimitCooldownMin -Reason "copilot_rate_limit_detected"
                                Write-Log "Closing Copilot PR #$($existingCopilot.number) due to rate limit comment" -Level "WARN"
                                if (-not $DryRun) {
                                    $null = Close-PRDeleteBranch -PRNumber $existingCopilot.number
                                }

                                $info.copilot_fix_requested = $false
                                $info.copilot_fix_requested_at = $null
                                $info.copilot_fix_pr_number = $null
                                $info.copilot_fix_merged = $false
                                $info.copilot_fix_stale = $true

                                $cooldown = $script:CopilotRateLimitCooldownMin
                                $localBody = @"
Copilot rate limit detected for sub-PR #$($existingCopilot.number). The sub-PR was closed and Copilot cloud is disabled for $cooldown minutes.

Please reattempt the fix locally (resolution mode: $($script:CopilotLocalResolution)) or via Vibe-Kanban per config.
"@
                                $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $localBody.Trim() -Reason "copilot_rate_limit"
                                $info.local_fix_requested = $true
                                break
                            }
                        }
                        $info.copilot_fix_requested = $true
                        $info.copilot_fix_pr_number = $existingCopilot.number
                        Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                            requested_at = (Get-Date).ToString("o")
                            completed    = $false
                            copilot_pr   = $existingCopilot.number
                            merged_at    = $null
                        }
                        break
                    }
                }

                if (-not $info.copilot_fix_requested) {
                    # Guard: never post @copilot if already mentioned or Copilot PR was closed
                    if ($alreadyMentioned) {
                        Write-Log "Skipping @copilot CI fix for PR #$($pr.number) — already mentioned or Copilot PR previously closed" -Level "WARN"
                        $info.copilot_fix_requested = $true
                        break
                    }
                    $copilotBody = @"
@copilot CI is failing for PR #$($pr.number).

$summary
"@
                    Write-Log "Requesting Copilot fix for PR #$($pr.number)" -Level "ACTION"
                    if (-not $DryRun) {
                        Add-PRComment -PRNumber $pr.number -Body $copilotBody.Trim() | Out-Null
                        Add-RecentItem -ListName "CopilotRequests" -Item @{
                            pr_number   = $pr.number
                            pr_title    = $pr.title
                            pr_url      = $pr.url
                            reason      = "ci_failing"
                            occurred_at = (Get-Date).ToString("o")
                        }
                    }
                    $info.copilot_fix_requested = $true
                    $info.copilot_fix_requested_at = Get-Date
                    $info.ci_notified = $false
                    Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                        requested_at = (Get-Date).ToString("o")
                        completed    = $false
                        copilot_pr   = $null
                        merged_at    = $null
                    }
                    break
                }
                elseif ($info.copilot_fix_requested -and -not $info.copilot_fix_merged) {
                    # Check if copilot fix is stale (requested > 60 min ago, not merged)
                    $sinceRequested = if ($info.copilot_fix_requested_at) { ((Get-Date) - $info.copilot_fix_requested_at).TotalMinutes } else { 0 }
                    if ($sinceRequested -ge 60) {
                        Write-Log "Copilot fix for PR #$($pr.number) is stale ($([int]$sinceRequested) min) — marking manual_review" -Level "WARN"
                        if ($info.copilot_fix_pr_number -and -not $DryRun) {
                            Write-Log "Closing stale Copilot sub-PR #$($info.copilot_fix_pr_number)" -Level "ACTION"
                            $null = Close-PRDeleteBranch -PRNumber $info.copilot_fix_pr_number
                        }
                        $info.status = "manual_review"
                        $info.copilot_fix_stale = $true
                        if (-not $DryRun) {
                            Update-VKTaskStatus -TaskId $info.task_id -Status "inreview" | Out-Null
                        }
                        $msg = "Copilot fix stale after $([int]$sinceRequested) min for PR #$($pr.number). Manual review required."
                        $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $msg -Reason "copilot_fix_stale"
                        break
                    }
                }

                if (-not $info.copilot_fix_merged) {
                    if (-not $info.copilot_fix_pr_number) {
                        $copilotPr = Find-CopilotFixPR -OriginalPRNumber $pr.number
                        if ($copilotPr) {
                            $info.copilot_fix_pr_number = $copilotPr.number
                            Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                                requested_at = (Get-Date).ToString("o")
                                completed    = $false
                                copilot_pr   = $copilotPr.number
                                merged_at    = $null
                            }
                        }
                    }

                    if ($info.copilot_fix_pr_number) {
                        $copilotDetails = Get-PRDetails -PRNumber $info.copilot_fix_pr_number
                        if (Test-GithubRateLimit) { return }
                        if ($copilotDetails -and $copilotDetails.isDraft) {
                            Write-Log "Marking Copilot PR #$($info.copilot_fix_pr_number) ready" -Level "ACTION"
                            if (-not $DryRun) {
                                $null = Mark-PRReady -PRNumber $info.copilot_fix_pr_number
                            }
                        }

                        $isCopilotComplete = if ($copilotDetails) { Test-CopilotPRComplete -PRDetails $copilotDetails } else { $false }
                        if ($isCopilotComplete) {
                            Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                                requested_at = (Get-Date).ToString("o")
                                completed    = $false
                                copilot_pr   = $info.copilot_fix_pr_number
                                merged_at    = $null
                            }
                        }

                        if ($copilotDetails -and $isCopilotComplete) {
                            Write-Log "Merging Copilot PR #$($info.copilot_fix_pr_number) into $branch" -Level "ACTION"
                            if (-not $DryRun) {
                                $mergedFix = Merge-BranchFromPR -BaseBranch $branch -HeadBranch $copilotDetails.headRefName
                                if ($mergedFix) {
                                    $info.copilot_fix_merged = $true
                                    $info.copilot_fix_merged_at = Get-Date
                                    Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                                        requested_at = (Get-Date).ToString("o")
                                        completed    = $true
                                        copilot_pr   = $info.copilot_fix_pr_number
                                        merged_at    = (Get-Date).ToString("o")
                                    }
                                    $null = Close-PRDeleteBranch -PRNumber $info.copilot_fix_pr_number
                                }
                            }
                        }
                    }

                    break
                }

                if ($info.copilot_fix_merged -and -not $info.ci_notified) {
                    $sinceMerge = if ($info.copilot_fix_merged_at) { ((Get-Date) - $info.copilot_fix_merged_at).TotalMinutes } else { 0 }
                    if ($sinceMerge -ge $CiWaitMin) {
                        $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $body.Trim() -Reason "ci_failing_after_copilot_merge"
                        $info.ci_notified = $true
                    }
                }
            }
            default {
                Write-Log "CI status unknown for PR #$($pr.number)" -Level "WARN"
            }
        }

      } catch {
        # Per-attempt error isolation: one attempt failure must not crash the entire loop
        $branchName = if ($info -and $info.branch) { $info.branch } else { "unknown" }
        Write-Log "EXCEPTION processing attempt $($attemptId.Substring(0,8)) (branch: $branchName): $($_.Exception.Message)" -Level "ERROR"
        Write-Log "Stack trace: $($_.ScriptStackTrace)" -Level "ERROR"
      }
    }

    # Clean up completed attempts from tracking
    foreach ($id in $processed) {
        $script:TrackedAttempts.Remove($id)
        $script:ProcessedAttemptIds.Add($id) | Out-Null
    }
    if ($processed.Count -gt 0) { Save-ProcessedAttemptIds }
    Save-StatusSnapshot
}

function Close-StaleCopilotPRs {
    <#
    .SYNOPSIS Close copilot fix PRs that have been open > 90 minutes without merging.
              Runs once per cycle to prevent endless sub-PR variants.
    #>
    foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
        $info = $entry.Value
        if (-not $info.copilot_fix_requested) { continue }
        if ($info.copilot_fix_merged) { continue }
        if ($info.copilot_fix_stale) { continue }

        $sinceRequested = if ($info.copilot_fix_requested_at) { ((Get-Date) - $info.copilot_fix_requested_at).TotalMinutes } else { 0 }
        if ($sinceRequested -lt 90) { continue }

        $attemptId = $entry.Key
        Write-Log "Stale copilot fix detected for attempt $($attemptId.Substring(0,8)) ($([int]$sinceRequested) min)" -Level "WARN"

        if ($info.copilot_fix_pr_number -and -not $DryRun) {
            Write-Log "Closing stale Copilot sub-PR #$($info.copilot_fix_pr_number)" -Level "ACTION"
            $null = Close-PRDeleteBranch -PRNumber $info.copilot_fix_pr_number
        }

        # Reset copilot fix state so task can be retried or manually reviewed
        $info.copilot_fix_requested = $false
        $info.copilot_fix_requested_at = $null
        $info.copilot_fix_pr_number = $null
        $info.copilot_fix_stale = $true
        $info.status = "manual_review"
        if (-not $DryRun) {
            Update-VKTaskStatus -TaskId $info.task_id -Status "inreview" | Out-Null
        }
    }
}

function Process-StandaloneCopilotPRs {
    <#
    .SYNOPSIS Merge completed Copilot-authored PRs (non-[WIP]) even without checks.
    #>
    if (Test-GithubCooldown) { return }
    $openPrs = Get-OpenPullRequests -Limit 200
    if (Test-GithubRateLimit) { return }
    if (-not $openPrs -or @($openPrs).Count -eq 0) { return }

    $copilotCandidates = @($openPrs | Where-Object {
            $_.author -and (Test-IsCopilotAuthor -Author $_.author)
        })
    if ($copilotCandidates.Count -gt 0) {
        Write-Log "Copilot PRs found: $($copilotCandidates.Count)" -Level "INFO"
    }

    foreach ($pr in $copilotCandidates) {
        if (-not $pr.author -or -not (Test-IsCopilotAuthor -Author $pr.author)) { continue }

        $details = Get-PRDetails -PRNumber $pr.number
        if (Test-GithubRateLimit) { return }
        if (-not $details) { continue }

        if (Test-CopilotCloudDisabled) {
            # Close ALL Copilot PRs when cloud is disabled — not just WIP/draft
            Write-Log "Closing Copilot PR #$($pr.number) while Copilot cloud is disabled" -Level "WARN"
            if (-not $DryRun) {
                $null = Close-PRDeleteBranch -PRNumber $pr.number
            }

            $requestedAt = if ($pr.createdAt) { $pr.createdAt } else { (Get-Date).ToString("o") }
            $refs = Get-ReferencedPRNumbers -Texts @(
                $pr.title,
                $details.body,
                $details.headRefName,
                $pr.headRefName
            )
            if (-not $refs -or @($refs).Count -eq 0) {
                Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                    requested_at = $requestedAt
                    completed    = $true
                    copilot_pr   = $pr.number
                    merged_at    = $null
                }
            }
            foreach ($ref in $refs) {
                Upsert-CopilotPRState -PRNumber $ref -Update @{
                    requested_at = $requestedAt
                    completed    = $true
                    copilot_pr   = $pr.number
                    merged_at    = $null
                }
            }
            continue
        }

        $rateLimitHit = $null
        if ($script:CopilotCloudDisableOnRateLimit) {
            $rateLimitHit = Test-CopilotRateLimitComment -PRNumber $pr.number
            if ($rateLimitHit -and $rateLimitHit.hit) {
                Disable-CopilotCloud -Minutes $script:CopilotRateLimitCooldownMin -Reason "copilot_rate_limit_detected"
            }
        }

        if ($rateLimitHit -and $rateLimitHit.hit) {
            Write-Log "Closing Copilot PR #$($pr.number) due to rate limit comment" -Level "WARN"
            if (-not $DryRun) {
                $null = Close-PRDeleteBranch -PRNumber $pr.number
            }

            $requestedAt = if ($pr.createdAt) { $pr.createdAt } else { (Get-Date).ToString("o") }
            $refs = Get-ReferencedPRNumbers -Texts @(
                $pr.title,
                $details.body,
                $details.headRefName,
                $pr.headRefName
            )
            if (-not $refs -or @($refs).Count -eq 0) {
                Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                    requested_at = $requestedAt
                    completed    = $true
                    copilot_pr   = $pr.number
                    merged_at    = $null
                }
            }

            $attemptEntry = $null
            foreach ($ref in $refs) {
                Upsert-CopilotPRState -PRNumber $ref -Update @{
                    requested_at = $requestedAt
                    completed    = $true
                    copilot_pr   = $pr.number
                    merged_at    = $null
                }
                if (-not $attemptEntry) {
                    $attemptEntry = $script:TrackedAttempts.GetEnumerator() | Where-Object {
                        $_.Value.pr_number -eq $ref
                    } | Select-Object -First 1
                }
            }

            if ($attemptEntry) {
                $attemptId = $attemptEntry.Key
                $info = $attemptEntry.Value
                $info.copilot_fix_requested = $false
                $info.copilot_fix_requested_at = $null
                $info.copilot_fix_pr_number = $null
                $info.copilot_fix_merged = $false
                $info.copilot_fix_stale = $true

                $cooldown = $script:CopilotRateLimitCooldownMin
                $message = @"
Copilot rate limit detected for sub-PR #$($pr.number). The sub-PR was closed and Copilot cloud is disabled for $cooldown minutes.

Please reattempt the fix locally (resolution mode: $($script:CopilotLocalResolution)) or via Vibe-Kanban per config.
"@
                $null = Try-SendFollowUp -AttemptId $attemptId -Info $info -Message $message.Trim() -Reason "copilot_rate_limit"
            }
            continue
        }

        # Auto-close stale WIP/draft Copilot PRs (> 60 min old)
        if ($pr.title -match '^\[WIP\]' -or $details.isDraft) {
            $prAge = 0
            if ($pr.createdAt) {
                try { $prAge = ((Get-Date) - [datetimeoffset]::Parse($pr.createdAt).ToLocalTime().DateTime).TotalMinutes } catch { $prAge = 0 }
            }
            if ($prAge -lt 60) {
                Write-Log "Copilot WIP PR #$($pr.number) is $([int]$prAge) min old — waiting" -Level "INFO"
                continue
            }
            Write-Log "Auto-closing stale Copilot WIP PR #$($pr.number) ($([int]$prAge) min old)" -Level "WARN"
            if (-not $DryRun) {
                $null = Close-PRDeleteBranch -PRNumber $pr.number
            }
            continue
        }
        $mergeState = if ($details.mergeStateStatus) { $details.mergeStateStatus } else { "UNKNOWN" }
        $mergeableState = if ($details.mergeable) { $details.mergeable } else { "UNKNOWN" }
        if ($mergeState -eq "CONFLICTING" -or $mergeableState -eq "CONFLICTING") {
            Write-Log "Closing Copilot PR #$($pr.number) due to conflicts ($mergeState)" -Level "WARN"
            if (-not $DryRun) {
                $null = Close-PRDeleteBranch -PRNumber $pr.number
                $requestedAt = if ($pr.createdAt) { $pr.createdAt } else { (Get-Date).ToString("o") }
                $refs = Get-ReferencedPRNumbers -Texts @(
                    $pr.title,
                    $details.body,
                    $details.headRefName,
                    $pr.headRefName
                )
                if (-not $refs -or @($refs).Count -eq 0) {
                    Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                        requested_at = $requestedAt
                        completed    = $true
                        copilot_pr   = $pr.number
                        merged_at    = $null
                    }
                }
                foreach ($ref in $refs) {
                    Upsert-CopilotPRState -PRNumber $ref -Update @{
                        requested_at = $requestedAt
                        completed    = $true
                        copilot_pr   = $pr.number
                        merged_at    = $null
                    }
                }
            }
            continue
        }
        if ($mergeState -eq "DIRTY" -and $mergeableState -ne "CONFLICTING") {
            Write-Log "Skipping Copilot PR #$($pr.number) due to DIRTY merge state" -Level "WARN"
            continue
        }

        if ($details.isDraft) {
            Write-Log "Marking Copilot PR #$($pr.number) ready" -Level "ACTION"
            if (-not $DryRun) {
                $null = Mark-PRReady -PRNumber $pr.number
            }
            # Re-fetch once after marking ready to attempt same-cycle merge.
            $details = Get-PRDetails -PRNumber $pr.number
            if (Test-GithubRateLimit) { return }
            if (-not $details -or $details.isDraft) { continue }
        }

        Write-Log "Merging Copilot PR #$($pr.number)" -Level "ACTION"
        if (-not $DryRun) {
            $mergeResult = Merge-PRWithFallback -PRNumber $pr.number -ForceAdmin:$UseAdminMerge
            if ($mergeResult.merged) {
                $requestedAt = if ($pr.createdAt) { $pr.createdAt } else { (Get-Date).ToString("o") }
                $refs = Get-ReferencedPRNumbers -Texts @(
                    $pr.title,
                    $details.body,
                    $details.headRefName,
                    $pr.headRefName
                )
                if (-not $refs -or @($refs).Count -eq 0) {
                    Upsert-CopilotPRState -PRNumber $pr.number -Update @{
                        requested_at = $requestedAt
                        completed    = $true
                        copilot_pr   = $pr.number
                        merged_at    = (Get-Date).ToString("o")
                    }
                }
                foreach ($ref in $refs) {
                    Upsert-CopilotPRState -PRNumber $ref -Update @{
                        requested_at = $requestedAt
                        completed    = $true
                        copilot_pr   = $pr.number
                        merged_at    = (Get-Date).ToString("o")
                    }
                }
            }
            else {
                $reason = if ($mergeResult.reason) { $mergeResult.reason } else { "Unknown merge error" }
                Write-Log "Merge failed for Copilot PR #$($pr.number): $reason" -Level "WARN"
            }
        }
    }
}

function Invoke-DownstreamRebase {
    <#
    .SYNOPSIS Trigger rebase for all active tasks targeting the same upstream branch.
    .DESCRIPTION After a PR merges, other tasks on the same upstream need rebasing.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamBranch,
        [string]$ExcludeAttemptId
    )

    # Prune stale worktrees first to avoid "already used by worktree" errors
    try {
        $pruneOutput = git worktree prune -v 2>&1
        if ($pruneOutput -and $pruneOutput -ne "") {
            Write-Log "Pruned stale worktrees before rebase: $pruneOutput" -Level "DEBUG"
        }
    }
    catch {
        Write-Log "Failed to prune worktrees before rebase: $_" -Level "WARN"
    }

    $rebaseTargets = @()
    foreach ($entry in $script:TrackedAttempts.GetEnumerator()) {
        $aid = $entry.Key
        $info = $entry.Value
        if ($aid -eq $ExcludeAttemptId) { continue }
        if ($info.status -notin @("inprogress", "inreview", "active", "running")) { continue }
        $taskUpstream = $info.upstream_branch
        if (-not $taskUpstream -and $info.task_id) {
            try {
                $taskObj = Get-VKTask -TaskId $info.task_id -ErrorAction SilentlyContinue
                if ($taskObj) { $taskUpstream = Get-TaskUpstreamBranch -Task $taskObj }
            }
            catch { }
        }
        if ($taskUpstream -eq $UpstreamBranch) {
            $rebaseTargets += @{ AttemptId = $aid; Info = $info }
        }
    }
    if ($rebaseTargets.Count -eq 0) {
        Write-Log "No downstream tasks to rebase for '$UpstreamBranch'" -Level "DEBUG"
        return
    }
    Write-Log "Found $($rebaseTargets.Count) downstream tasks to rebase after merge on '$UpstreamBranch'" -Level "INFO"
    $rebased = 0; $failed = 0
    foreach ($target in $rebaseTargets) {
        $aid = $target.AttemptId
        $shortId = $aid.Substring(0, [Math]::Min(8, $aid.Length))
        try {
            $branch = $target.Info.branch ?? "ve/$shortId"
            Write-Log "Rebasing downstream task $shortId (branch: $branch) onto $UpstreamBranch" -Level "INFO"

            # Find the worktree path for this branch (if it exists)
            $worktreePath = Get-WorktreePathForBranch -Branch $branch

            if ($worktreePath -and (Test-Path $worktreePath)) {
                # Rebase within the worktree to avoid "already used by worktree" errors
                Write-Log "Rebasing within worktree: $worktreePath" -Level "DEBUG"
                if (-not (Test-GitWorktreeClean -RepoPath $worktreePath -Label $worktreePath)) {
                    $failed++
                    Write-Log "Rebase skipped for $shortId — worktree has uncommitted changes" -Level "WARN"
                    continue
                }
                $result = git -C $worktreePath rebase $UpstreamBranch 2>&1
            }
            else {
                # No worktree exists, use standard rebase
                $repoPath = (Get-Location).Path
                if (-not (Test-GitWorktreeClean -RepoPath $repoPath -Label $repoPath)) {
                    $failed++
                    Write-Log "Rebase skipped for $shortId — repo has uncommitted changes" -Level "WARN"
                    continue
                }
                $result = & git rebase $UpstreamBranch $branch 2>&1
            }

            if ($LASTEXITCODE -eq 0) {
                $rebased++
                Write-Log "Rebased $shortId successfully" -Level "OK"
            }
            else {
                $failed++
                Write-Log "Rebase failed for $shortId - may need manual resolution: $result" -Level "WARN"
                if ($worktreePath -and (Test-Path $worktreePath)) {
                    git -C $worktreePath rebase --abort 2>&1 | Out-Null
                }
                else {
                    & git rebase --abort 2>&1 | Out-Null
                }
            }
        }
        catch {
            $failed++
            Write-Log "Error rebasing $shortId`: $_" -Level "ERROR"
            $branch = $target.Info.branch ?? "ve/$shortId"
            $worktreePath = Get-WorktreePathForBranch -Branch $branch
            if ($worktreePath -and (Test-Path $worktreePath)) {
                git -C $worktreePath rebase --abort 2>&1 | Out-Null
            }
            else {
                & git rebase --abort 2>&1 | Out-Null
            }
        }
    }
    if ($rebased -gt 0 -or $failed -gt 0) {
        $msg = "Downstream rebase: $rebased OK, $failed failed (upstream: $UpstreamBranch)"
        Write-Log $msg -Level $(if ($failed -gt 0) { "WARN" } else { "OK" })
    }
}

function Complete-Task {
    <#
    .SYNOPSIS Mark a task as done after its PR is merged.
    #>
    [CmdletBinding()]
    param(
        [string]$AttemptId,
        [string]$TaskId,
        [int]$PRNumber
    )
    Write-Log "Marking task $($TaskId.Substring(0,8)) as done (PR #$PRNumber merged)" -Level "OK"
    $taskTitle = $null
    if ($AttemptId -and $script:TrackedAttempts.ContainsKey($AttemptId)) {
        $taskTitle = $script:TrackedAttempts[$AttemptId].name
    }
    $prDetails = Get-PRDetails -PRNumber $PRNumber
    if (Test-GithubRateLimit) {
        $prDetails = $null
    }
    $prTitle = if ($prDetails -and $prDetails.title) { $prDetails.title } else { $null }
    $prUrl = if ($prDetails -and $prDetails.url) { $prDetails.url } else { $null }
    if (-not $DryRun) {
        Archive-VKAttempt -AttemptId $AttemptId | Out-Null
        Update-VKTaskStatus -TaskId $TaskId -Status "done"
    }
    Add-RecentItem -ListName "CompletedTasks" -Item @{
        task_id      = $TaskId
        task_title   = $taskTitle
        pr_number    = $PRNumber
        pr_title     = $prTitle
        pr_url       = $prUrl
        completed_at = (Get-Date).ToString("o")
    }
    $script:TasksCompleted++
    $script:TotalTasksCompleted++
    Update-CISweepState -TotalTasksCompleted $script:TotalTasksCompleted

    # ─── Success rate classification ─────────────────────────────────────────
    $neededFix = $false
    if ($AttemptId -and $script:TrackedAttempts.ContainsKey($AttemptId)) {
        $info = $script:TrackedAttempts[$AttemptId]
        if ($info.copilot_fix_requested -or $info.copilot_fix_merged) {
            $neededFix = $true
        }
        if ($info.merge_failures_total -gt 0 -and $info.last_merge_failure_category -eq "conflict") {
            $neededFix = $true
        }
        if ($info.status -in @("error", "manual_review")) {
            $neededFix = $true
        }
    }
    if ($neededFix) {
        $script:TasksNeededFix++
        Write-Log "Task $($TaskId.Substring(0,8)) merged after fix (needed intervention)" -Level "INFO"
    }
    else {
        $script:FirstShotSuccess++
        Write-Log "Task $($TaskId.Substring(0,8)) merged first-shot" -Level "OK"
    }
    Save-SuccessMetrics

    # ─── Downstream rebase trigger (v0.8) ────────────────────────────────────
    if ($script:AutoRebaseOnMerge -and $AttemptId -and $script:TrackedAttempts.ContainsKey($AttemptId)) {
        $info = $script:TrackedAttempts[$AttemptId]
        $mergedUpstream = $info.upstream_branch
        if (-not $mergedUpstream -and $TaskId) {
            # Fallback: resolve from task
            try {
                $taskObj = Get-VKTask -TaskId $TaskId -ErrorAction SilentlyContinue
                if ($taskObj) { $mergedUpstream = Get-TaskUpstreamBranch -Task $taskObj }
            }
            catch { }
        }
        if ($mergedUpstream) {
            Write-Log "Triggering downstream rebase for tasks on '$mergedUpstream' (excluding $($AttemptId.Substring(0,8)))" -Level "INFO"
            Invoke-DownstreamRebase -UpstreamBranch $mergedUpstream -ExcludeAttemptId $AttemptId
        }
    }

    Maybe-TriggerCISweep
}

function Save-SuccessMetrics {
    <#
    .SYNOPSIS Persist success rate metrics to disk for monitoring.
    #>
    $total = $script:FirstShotSuccess + $script:TasksNeededFix + $script:TasksFailed
    $rate = if ($total -gt 0) { [math]::Round(($script:FirstShotSuccess / $total) * 100, 1) } else { 0 }
    $metrics = @{
        updated_at         = (Get-Date).ToString("o")
        first_shot_success = $script:FirstShotSuccess
        needed_fix         = $script:TasksNeededFix
        failed             = $script:TasksFailed
        total_decided      = $total
        first_shot_rate    = $rate
        session_start      = $script:StartTime.ToString("o")
    }
    $dir = Split-Path -Parent $script:SuccessMetricsPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $metrics | ConvertTo-Json -Depth 3 | Set-Content -Path $script:SuccessMetricsPath -Encoding UTF8
}

function Get-SuccessRateSummary {
    <#
    .SYNOPSIS Return a formatted string showing current success rate.
    #>
    $total = $script:FirstShotSuccess + $script:TasksNeededFix + $script:TasksFailed
    $rate = if ($total -gt 0) { [math]::Round(($script:FirstShotSuccess / $total) * 100, 1) } else { 0 }
    return "First-shot: ${rate}% ($($script:FirstShotSuccess)/$total) | Fix: $($script:TasksNeededFix) | Failed: $($script:TasksFailed)"
}

function Get-BaseBranchName {
    param([string]$Branch)
    $base = if ($Branch) { $Branch } else { $script:VK_TARGET_BRANCH }
    if (-not $base) { $base = "origin/main" }
    if ($base -like "origin/*") { $base = $base.Substring(7) }
    return $base
}

function Get-MergedPRCountSince {
    <#
    .SYNOPSIS Count merged PRs on main since a timestamp.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Since,
        [string]$BaseBranch,
        [int]$Limit = 50
    )
    if (-not $Since) { return 0 }
    $base = Get-BaseBranchName -Branch $BaseBranch
    $prJson = Invoke-VKGithub -Args @(
        "pr", "list", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--state", "merged", "--base", $base,
        "--limit", $Limit.ToString(),
        "--json", "number,mergedAt"
    )
    if (Test-GithubRateLimit) { return 0 }
    if (-not $prJson -or $prJson -eq "[]") { return 0 }
    $prs = $prJson | ConvertFrom-Json
    if (-not $prs) { return 0 }
    try {
        $sinceTime = [datetimeoffset]::Parse($Since)
    }
    catch {
        return 0
    }
    $count = 0
    foreach ($pr in $prs) {
        if (-not $pr.mergedAt) { continue }
        try {
            $mergedAt = [datetimeoffset]::Parse($pr.mergedAt)
            if ($mergedAt -gt $sinceTime) { $count++ }
        }
        catch {
            continue
        }
    }
    return $count
}

function Maybe-TriggerCISweep {
    <#
    .SYNOPSIS Trigger a Copilot CI sweep based on completed tasks and PR backup thresholds.
    #>
    $threshold = [int]($script:CiSweepEvery ?? 0)
    $totalCompleted = [int]($script:TotalTasksCompleted ?? 0)
    if ($threshold -gt 0 -and $totalCompleted -ge $threshold -and ($totalCompleted % $threshold) -eq 0) {
        $state = Get-OrchestratorState
        if ($state.last_ci_sweep_completed -eq $totalCompleted) { return }

        $reason = "task-count"
        $info = "Total tasks completed: $totalCompleted (threshold: $threshold)"
        Trigger-CISweep -Reason $reason -TriggerInfo $info
        $now = (Get-Date).ToString("o")
        $script:LastCISweepAt = $now
        Update-CISweepState -TotalTasksCompleted $totalCompleted -LastSweepAt $now -LastSweepCompleted $totalCompleted
        return
    }

    if (-not $script:CiSweepPrBackupEnabled) { return }
    $prThreshold = [int]($script:CiSweepPrEvery ?? 0)
    if ($prThreshold -le 0) { return }
    if (-not $script:LastCISweepAt) { return }
    if (Test-GithubCooldown) { return }

    $baseBranch = Get-BaseBranchName
    $limit = [math]::Max(50, $prThreshold * 2)
    $mergedCount = Get-MergedPRCountSince -Since $script:LastCISweepAt -BaseBranch $baseBranch -Limit $limit
    if ($mergedCount -lt $prThreshold) { return }

    $reason = "pr-backup"
    $info = "Merged PRs since $($script:LastCISweepAt): $mergedCount (threshold: $prThreshold)"
    Trigger-CISweep -Reason $reason -TriggerInfo $info
    $now = (Get-Date).ToString("o")
    $script:LastCISweepAt = $now
    Update-CISweepState -TotalTasksCompleted $totalCompleted -LastSweepAt $now -LastSweepCompleted $totalCompleted
}

function Trigger-CISweep {
    <#
    .SYNOPSIS Create a Copilot-driven CI sweep issue.
    #>
    [CmdletBinding()]
    param(
        [string]$Reason = "task-count",
        [string]$TriggerInfo = ""
    )
    if (Test-CopilotCloudDisabled) {
        Write-Log "Copilot cloud disabled — creating local CI sweep task" -Level "WARN"
        $title = "ci sweep: resolve failing workflows"
        $body = @"
Please review GitHub Actions failures across the repository and resolve them.

Scope:
- Identify failing workflows on main.
- Prioritize required checks and security scans.
- Apply minimal fixes and open PRs as needed.
Trigger reason: $Reason
Trigger info: $TriggerInfo
"@
        if (-not $DryRun) {
            $null = Create-VKTask -Title $title -Description $body.Trim() -Status "todo"
        }
        return
    }
    $failedRuns = @()
    $recentMerged = @()
    if (-not (Test-GithubRateLimit)) {
        $failedRuns = Get-FailingWorkflowRuns -Limit 10
        $recentMerged = Get-RecentMergedPRs -Limit 15
    }

    $failedRunLines = if ($failedRuns -and @($failedRuns).Count -gt 0) {
        $failedRuns | ForEach-Object {
            $name = if ($_.name) { $_.name } elseif ($_.workflow_name) { $_.workflow_name } else { "workflow" }
            $url = if ($_.html_url) { $_.html_url } else { "" }
            $conclusion = if ($_.conclusion) { $_.conclusion } else { "unknown" }
            if ($url) { "- $name ($conclusion): $url" } else { "- $name ($conclusion)" }
        }
    }
    else { @("- none") }

    $mergedLines = if ($recentMerged -and @($recentMerged).Count -gt 0) {
        $recentMerged | ForEach-Object {
            $title = if ($_.title) { $_.title } else { "PR #$($_.number)" }
            $url = if ($_.url) { $_.url } else { "" }
            if ($url) { "- #$($_.number) ${title}: $url" } else { "- #$($_.number) $title" }
        }
    }
    else { @("- none") }

    $title = "ci sweep: resolve failing workflows"
    $reasonLine = if ($Reason) { "Trigger reason: $Reason" } else { $null }
    $infoLine = if ($TriggerInfo) { "Trigger info: $TriggerInfo" } else { $null }
    $body = @"
Copilot assignment: this issue will be assigned via API. If it is unassigned, use the "Assign to Copilot" button.

@copilot Please review GitHub Actions failures across the repository and resolve them.

Scope:
- Identify failing workflows on main.
- Prioritize required checks and security scans.
- Apply minimal fixes and open PRs as needed.
$reasonLine
$infoLine

Recent failing workflow runs (main):
$($failedRunLines -join "`n")

Recent merged PRs (last 15):
$($mergedLines -join "`n")
"@

    $logReason = if ($Reason) { $Reason } else { "scheduled" }
    Write-Log "Triggering CI sweep ($logReason)" -Level "ACTION"
    if (-not $DryRun) {
        $issue = Create-GithubIssue -Title $title -Body $body
        if ($issue -and $issue.number) {
            $assigned = Assign-IssueToCopilot -IssueNumber $issue.number
            if (-not $assigned) {
                Write-Log "Copilot assignment failed for issue #$($issue.number)" -Level "WARN"
            }
        }
    }
}

function Test-TaskFileOverlap {
    <#
    .SYNOPSIS Check if a task's likely target files overlap with active agent branches.
              Returns $true if overlap detected (should skip), $false if safe.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskTitle,
        [Parameter(Mandatory)][string]$TaskId
    )

    # Map task title keywords to likely file paths/modules
    $modulePatterns = @{
        'portal'     = @('portal/', 'lib/portal/', 'lib/capture/', 'lib/admin/', 'pnpm-lock.yaml')
        'veid'       = @('x/veid/', 'pkg/inference/')
        'market'     = @('x/market/')
        'escrow'     = @('x/escrow/')
        'mfa'        = @('x/mfa/')
        'encryption' = @('x/encryption/')
        'provider'   = @('pkg/provider_daemon/', 'cmd/provider-daemon/')
        'hpc'        = @('x/hpc/')
        'roles'      = @('x/roles/')
        'sdk'        = @('sdk/')
        'app'        = @('app/')
        'ci'         = @('.github/', 'Makefile', 'make/')
        'ml'         = @('ml/')
        'deps'       = @('go.mod', 'go.sum', 'vendor/')
    }

    # Determine this task's likely modules from title
    $titleLower = $TaskTitle.ToLower()
    $taskModules = [System.Collections.Generic.List[string]]::new()
    foreach ($kv in $modulePatterns.GetEnumerator()) {
        if ($titleLower -match $kv.Key) {
            foreach ($p in $kv.Value) { $taskModules.Add($p) }
        }
    }

    # If we can't determine the module, allow it (don't block unknowns)
    if ($taskModules.Count -eq 0) { return $false }

    # Check active agents' branches for file overlap
    $activeAttempts = $script:TrackedAttempts.Values | Where-Object { $_.status -eq "running" -and $_.branch }
    foreach ($active in $activeAttempts) {
        if ($active.task_id -eq $TaskId) { continue }

        $activeName = if ($active.name) { $active.name.ToLower() } else { "" }
        foreach ($kv in $modulePatterns.GetEnumerator()) {
            if ($activeName -match $kv.Key) {
                # Check if any of the active's modules overlap with this task's modules
                foreach ($activeP in $kv.Value) {
                    foreach ($taskP in $taskModules) {
                        if ($activeP -eq $taskP -or $activeP.StartsWith($taskP) -or $taskP.StartsWith($activeP)) {
                            Write-Log "Task overlap: '$($TaskTitle.Substring(0, [Math]::Min(50, $TaskTitle.Length)))' conflicts with active '$($active.name)' on $activeP" -Level "WARN"
                            return $true
                        }
                    }
                }
            }
        }
    }

    # Global conflict files — Go module changes always risk go.mod/vendor conflicts
    $goModules = @('veid', 'market', 'escrow', 'mfa', 'encryption', 'hpc', 'roles', 'provider', 'app', 'sdk', 'ml')
    $taskIsGo = $goModules | Where-Object { $titleLower -match $_ }
    if ($taskIsGo) {
        $activeGoCount = @($activeAttempts | Where-Object {
                $n = if ($_.name) { $_.name.ToLower() } else { "" }
                $goModules | Where-Object { $n -match $_ }
            }).Count
        # Allow up to 2 parallel Go module tasks, defer beyond that
        if ($activeGoCount -ge 2) {
            Write-Log "Task overlap: deferring Go task '$($TaskTitle.Substring(0, [Math]::Min(50, $TaskTitle.Length)))' — $activeGoCount Go tasks already active" -Level "WARN"
            return $true
        }
    }

    # Portal tasks — only 1 at a time (pnpm-lock.yaml conflicts)
    $taskIsPortal = $titleLower -match 'portal|frontend|capture|admin|ui'
    if ($taskIsPortal) {
        $activePortalCount = @($activeAttempts | Where-Object {
                $n = if ($_.name) { $_.name.ToLower() } else { "" }
                $n -match 'portal|frontend|capture|admin|ui'
            }).Count
        if ($activePortalCount -ge 1) {
            Write-Log "Task overlap: deferring portal task — $activePortalCount portal tasks already active" -Level "WARN"
            return $true
        }
    }

    return $false
}

# ── Dirty/Conflict Task Prioritization ────────────────────────────────────────

# In-memory dirty PR tracking
$script:DirtyPRTasks = @{}       # taskId → @{ prNumber; branch; title; detectedAt; files }
$script:DirtyResolutionCooldown = @{} # taskId → last resolution timestamp
$script:DIRTY_COOLDOWN_MS = 15 * 60 * 1000  # 15 minutes between resolution attempts
$script:DIRTY_RESERVED_SLOTS = 1  # Reserve 1 slot for dirty/conflict resolution
$script:DIRTY_MAX_CONCURRENT = 2  # Max concurrent dirty resolutions

function Register-DirtyPRTask {
    <#
    .SYNOPSIS Track a task whose PR has merge conflicts (dirty state).
    #>
    param(
        [string]$TaskId,
        [int]$PrNumber,
        [string]$Branch,
        [string]$Title,
        [string[]]$Files = @()
    )
    $script:DirtyPRTasks[$TaskId] = @{
        prNumber   = $PrNumber
        branch     = $Branch
        title      = $Title
        detectedAt = (Get-Date)
        files      = $Files
        attempts   = 0
    }
    Write-Log "Registered dirty PR: task=$($TaskId.Substring(0,8)) PR=#$PrNumber branch=$Branch" -Level "WARN"
}

function Clear-DirtyPRTask {
    <#
    .SYNOPSIS Remove a task from dirty tracking (resolved or merged).
    #>
    param([string]$TaskId)
    $script:DirtyPRTasks.Remove($TaskId)
    $script:DirtyResolutionCooldown.Remove($TaskId)
}

function Get-DirtyPRTasks {
    <#
    .SYNOPSIS Get all currently tracked dirty/conflict tasks.
    .OUTPUTS Array of dirty task objects.
    #>
    return @($script:DirtyPRTasks.Values)
}

function Test-DirtyPRFileOverlap {
    <#
    .SYNOPSIS Check if a new task would touch the same files as an active dirty PR.
              If yes, the new task should be DEFERRED to avoid creating more conflicts.
    .OUTPUTS $true if there's file overlap with a dirty PR (should defer).
    #>
    param(
        [string]$TaskTitle,
        [string]$TaskId
    )

    $dirtyTasks = @($script:DirtyPRTasks.Values)
    if ($dirtyTasks.Count -eq 0) { return $false }

    $modulePatterns = @{
        'portal'       = @('portal/', 'lib/portal/', 'lib/capture/', 'lib/admin/', 'pnpm-lock.yaml')
        'veid'         = @('x/veid/', 'pkg/inference/')
        'market'       = @('x/market/')
        'escrow'       = @('x/escrow/')
        'mfa'          = @('x/mfa/')
        'encryption'   = @('x/encryption/')
        'provider'     = @('pkg/provider_daemon/', 'cmd/provider-daemon/')
        'hpc'          = @('x/hpc/')
        'roles'        = @('x/roles/')
        'sdk'          = @('sdk/')
        'app'          = @('app/')
        'ci'           = @('.github/', 'Makefile', 'make/')
        'ml'           = @('ml/')
        'deps'         = @('go.mod', 'go.sum', 'vendor/')
        'OpenFleet' = @('scripts/openfleet/')
    }

    $titleLower = $TaskTitle.ToLower()
    $taskModules = [System.Collections.Generic.List[string]]::new()
    foreach ($kv in $modulePatterns.GetEnumerator()) {
        if ($titleLower -match $kv.Key) {
            foreach ($p in $kv.Value) { $taskModules.Add($p) }
        }
    }

    # Unknown modules → allow (don't block)
    if ($taskModules.Count -eq 0) { return $false }

    foreach ($dirty in $dirtyTasks) {
        # Determine dirty task's likely modules
        $dirtyTitleLower = if ($dirty.title) { $dirty.title.ToLower() } else { "" }
        $dirtyModules = [System.Collections.Generic.List[string]]::new()

        # From dirty task's title
        foreach ($kv in $modulePatterns.GetEnumerator()) {
            if ($dirtyTitleLower -match $kv.Key) {
                foreach ($p in $kv.Value) { $dirtyModules.Add($p) }
            }
        }
        # From dirty task's changed files
        foreach ($f in $dirty.files) {
            $dirtyModules.Add($f)
        }

        # Check overlap
        foreach ($tp in $taskModules) {
            foreach ($dp in $dirtyModules) {
                if ($tp -eq $dp -or $tp.StartsWith($dp) -or $dp.StartsWith($tp)) {
                    Write-Log "Dirty PR overlap: task '$($TaskTitle.Substring(0, [Math]::Min(50, $TaskTitle.Length)))' conflicts with dirty PR #$($dirty.prNumber) '$($dirty.title)' on $dp" -Level "WARN"
                    return $true
                }
            }
        }

        # Go module global conflict check
        $goModules = @('veid', 'market', 'escrow', 'mfa', 'encryption', 'hpc', 'roles', 'provider', 'app', 'sdk')
        $taskIsGo = $goModules | Where-Object { $titleLower -match $_ }
        $dirtyHasGoFiles = @($dirty.files) | Where-Object { $_ -match '^go\.(mod|sum)$' -or $_ -match '^vendor/' }
        if ($taskIsGo -and $dirtyHasGoFiles) {
            Write-Log "Dirty PR Go overlap: task '$($TaskTitle.Substring(0, [Math]::Min(50, $TaskTitle.Length)))' conflicts with dirty PR #$($dirty.prNumber) on Go module files" -Level "WARN"
            return $true
        }
    }

    return $false
}

function Get-DirtySlotReservation {
    <#
    .SYNOPSIS Calculate effective slot capacity after reserving for dirty tasks.
    .OUTPUTS Hashtable with effectiveCapacity, reservedForDirty, hasDirtyTasks.
    #>
    param(
        [double]$TotalCapacity,
        [double]$ActiveWeight
    )

    $dirtyCount = $script:DirtyPRTasks.Count
    if ($dirtyCount -eq 0) {
        return @{
            effectiveCapacity = $TotalCapacity
            reservedForDirty  = 0
            hasDirtyTasks     = $false
            dirtyCount        = 0
        }
    }

    # Count how many dirty tasks are already being resolved
    $activeDirtyCount = @($script:TrackedAttempts.Values | Where-Object {
            $_.status -eq "running" -and $_.is_dirty_resolution -eq $true
        }).Count

    if ($activeDirtyCount -ge $script:DIRTY_MAX_CONCURRENT) {
        return @{
            effectiveCapacity = $TotalCapacity
            reservedForDirty  = 0
            hasDirtyTasks     = $true
            dirtyCount        = $dirtyCount
        }
    }

    # Reserve slots — never more than 25% of capacity
    $reserved = [math]::Min($script:DIRTY_RESERVED_SLOTS, [math]::Max(1, [math]::Floor($TotalCapacity * 0.25)))
    return @{
        effectiveCapacity = [math]::Max(0, $TotalCapacity - $reserved)
        reservedForDirty  = $reserved
        hasDirtyTasks     = $true
        dirtyCount        = $dirtyCount
    }
}

function Resolve-ExecutorForDirtyTask {
    <#
    .SYNOPSIS Force the HIGHEST model tier for dirty/conflict task resolution.
              Dirty tasks ALWAYS get the most capable model, regardless of task size.
    #>
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][hashtable]$BaseProfile
    )

    $executor = if ($BaseProfile.executor) { $BaseProfile.executor.ToUpper() } else { "CODEX" }

    # Force HIGH tier
    $highModels = $script:ComplexityModels
    if (-not $highModels) {
        # Fallback to hardcoded HIGH tier
        if ($executor -eq "COPILOT") {
            return @{
                executor        = "COPILOT"
                variant         = "CLAUDE_OPUS_4_6"
                model           = "opus-4.6"
                reasoningEffort = "high"
                complexity      = @{ tier = "high"; reason = "dirty/conflict → forced HIGH"; adjusted = $true }
            }
        }
        return @{
            executor        = "CODEX"
            variant         = "GPT51_CODEX_MAX"
            model           = "gpt-5.1-codex-max"
            reasoningEffort = "high"
            complexity      = @{ tier = "high"; reason = "dirty/conflict → forced HIGH"; adjusted = $true }
        }
    }

    $model = $highModels[$executor]?.high
    if (-not $model) {
        $model = @{ Model = "gpt-5.1-codex-max"; Variant = "GPT51_CODEX_MAX"; Reasoning = "high" }
    }

    return @{
        executor        = $executor
        variant         = $model.Variant
        model           = $model.Model
        reasoningEffort = $model.Reasoning
        complexity      = @{ tier = "high"; reason = "dirty/conflict → forced HIGH"; adjusted = $true }
    }
}

function Fill-ParallelSlots {
    <#
    .SYNOPSIS Submit new task attempts to reach the target parallelism.
              Enforces merge gate: won't start new tasks if previous ones have unmerged PRs.
              Uses 50/50 Codex/Copilot executor cycling.
              Reserves slots for dirty/conflict resolution tasks.
              Dirty tasks get priority over new tasks and use highest models.
    #>
    $capacityInfo = Get-AvailableSlotCapacity
    $remainingCapacity = $capacityInfo.remaining
    $capacity = $capacityInfo.capacity
    $activeCount = $capacityInfo.active_count
    $activeWeight = $capacityInfo.active_weight

    # ── Dirty/Conflict Slot Reservation ──────────────────────────────────────
    # Reserve slot(s) for dirty/conflict tasks so new tasks don't fill ALL capacity
    $dirtyReservation = Get-DirtySlotReservation -TotalCapacity $capacity -ActiveWeight $activeCount
    if ($dirtyReservation.hasDirtyTasks) {
        $effectiveCap = $dirtyReservation.effectiveCapacity
        $reservedSlots = $dirtyReservation.reservedForDirty
        $dirtyCount = $dirtyReservation.dirtyCount
        Write-Log ("Dirty/conflict tasks: {0} detected — reserving {1} slot(s) for resolution (effective capacity for new tasks: {2})" -f `
                $dirtyCount, $reservedSlots, [math]::Round($effectiveCap, 2)) -Level "WARN"
        # Reduce remaining capacity for new tasks (dirty tasks get their own path)
        $remainingCapacity = [math]::Max(0, $effectiveCap - $activeCount)
    }

    if ($remainingCapacity -lt 0.75) {
        Write-Log "All slots occupied (capacity: $capacity, active: $activeCount tasks, weight: $([math]::Round($activeWeight, 2)))" -Level "INFO"
        return
    }

    Write-Log ("{0} slot(s) available (capacity: {1}, active: {2} tasks, weight: {3})" -f `
            [math]::Floor($remainingCapacity), $capacity, $activeCount, [math]::Round($activeWeight, 2)) -Level "ACTION"

    $maxCandidates = [math]::Min(50, [math]::Max(10, [int][math]::Ceiling($capacity * 4)))
    $nextTasks = Get-OrderedTodoTasks -Count $maxCandidates
    if (-not $nextTasks -or @($nextTasks).Count -eq 0) {
        Write-Log "No more todo tasks in backlog" -Level "WARN"
        return
    }

    # Log the sequence-based ordering for visibility
    $topCandidates = @($nextTasks | Select-Object -First 5)
    $candidateNames = @($topCandidates | ForEach-Object {
            $seq = if ($_.title) { Get-SequenceValue -Title $_.title } else { $null }
            $short = if ($_.title) { $_.title.Substring(0, [Math]::Min(50, $_.title.Length)) } else { "(untitled)" }
            if ($seq) { "$short (seq=$seq)" } else { "$short (no-seq)" }
        })
    Write-Log ("Task queue (top {0}): {1}" -f $candidateNames.Count, ($candidateNames -join " > ")) -Level "INFO"

    $started = 0
    foreach ($task in $nextTasks) {
        if ($remainingCapacity -lt 0.75) { break }

        # Skip tasks that already have a tracked (non-done) attempt
        $existingAttempt = $script:TrackedAttempts.Values | Where-Object { $_.task_id -eq $task.id -and $_.status -ne "done" }
        if ($existingAttempt) {
            Write-Log "Task $($task.id.Substring(0,8)) already has active attempt, skipping" -Level "INFO"
            continue
        }

        # ── Check if task description indicates it's already completed ──────────────
        $taskDesc = if ($task.description) { $task.description.ToLower() } else { "" }
        $completionPatterns = @("superseded by", "already completed", "this task has been completed", "merged in", "completed via", "no longer needed")
        $isAlreadyComplete = $false
        foreach ($pattern in $completionPatterns) {
            if ($taskDesc -match [regex]::Escape($pattern)) {
                $isAlreadyComplete = $true
                break
            }
        }
        if ($isAlreadyComplete) {
            Write-Log "Task $($task.id.Substring(0,8)) marked as already completed in description — archiving" -Level "INFO"
            if (-not $DryRun) {
                try {
                    # Move to done status instead of cancelled
                    Update-VKTaskStatus -TaskId $task.id -Status "done" | Out-Null
                    Write-Log "Marked completed task $($task.id.Substring(0,8)) as done" -Level "OK"
                }
                catch {
                    Write-Log "Failed to mark task $($task.id.Substring(0,8)) as done: $_" -Level "WARN"
                }
            }
            continue
        }

        # Pre-flight: check file overlap with active agents
        $taskTitle = if ([string]::IsNullOrWhiteSpace($task.title)) { "" } else { $task.title }
        if (Test-TaskFileOverlap -TaskTitle $taskTitle -TaskId $task.id) {
            Write-Log "Deferring task $($task.id.Substring(0,8)) — file overlap with active agent" -Level "INFO"
            continue
        }

        # ── Dirty PR file-overlap guard ──────────────────────────────────────
        # Don't schedule tasks that touch the same files as an active dirty PR
        if (Test-DirtyPRFileOverlap -TaskTitle $taskTitle -TaskId $task.id) {
            Write-Log "Deferring task $($task.id.Substring(0,8)) — file overlap with dirty/conflict PR" -Level "WARN"
            continue
        }

        # ── Check if this IS a dirty/conflict task (prioritize + force HIGH model) ──
        $isDirtyTask = $script:DirtyPRTasks.ContainsKey($task.id)

        $sizeInfo = Get-TaskSizeInfo -Task $task
        # Weight is used for complexity routing / model selection only — NOT for scheduling capacity.
        # Each task consumes exactly 1 slot regardless of weight. MaxParallel=N means N concurrent agents.
        if ($remainingCapacity -lt 1) {
            # Dirty tasks get priority even when capacity is tight (use reserved slot)
            if (-not $isDirtyTask) {
                Write-Log ("Deferring task {0} — no remaining slot capacity ({1})" -f `
                        $task.id.Substring(0, 8), [math]::Round($remainingCapacity, 2)) -Level "INFO"
                continue
            }
            Write-Log ("Dirty task {0} using reserved slot — size {1} (weight {2})" -f `
                    $task.id.Substring(0, 8), $sizeInfo.label, $sizeInfo.weight) -Level "WARN"
        }

        $title = if ([string]::IsNullOrWhiteSpace($task.title)) {
            if ($task.id) { "Task $($task.id.Substring(0,8))" } else { "Task (untitled)" }
        }
        else {
            $task.title
        }
        $shortTitle = $title.Substring(0, [Math]::Min(70, $title.Length))
        $targetBranch = Get-TaskUpstreamBranch -Task $task
        $baseExec = Get-CurrentExecutorProfile

        # ── Force highest model for dirty tasks ──────────────────────────────
        $nextExec = if ($isDirtyTask) {
            $dirtyExec = Resolve-ExecutorForDirtyTask -Task $task -BaseProfile $baseExec
            Write-Log "DIRTY TASK: $shortTitle — forcing HIGH model [$($dirtyExec.executor)/$($dirtyExec.model)]" -Level "WARN"
            $dirtyExec
        }
        else {
            Resolve-ExecutorForComplexity -Task $task -BaseProfile $baseExec
        }
        $complexityTag = if ($nextExec.complexity) { " complexity=$($nextExec.complexity.tier)" } else { "" }
        Write-Log "Submitting: $shortTitle [$($nextExec.executor)/$($nextExec.model)]$complexityTag (base: $targetBranch)" -Level "ACTION"

        if (-not $DryRun) {
            $execOverride = @{
                executor = $nextExec.executor
                variant  = $nextExec.variant
            }
            $attempt = Submit-VKTaskAttempt -TaskId $task.id -TargetBranch $targetBranch -ExecutorOverride $execOverride
            if ($attempt) {
                # Move task to inprogress on VK board when agent starts
                Update-VKTaskStatus -TaskId $task.id -Status "inprogress" | Out-Null
                $priorityInfo = Get-TaskPriorityInfo -Task $task
                $script:TrackedAttempts[$attempt.id] = @{
                    task_id              = $task.id
                    branch               = $attempt.branch
                    target_branch        = $targetBranch
                    pr_number            = $null
                    status               = "running"
                    name                 = $title
                    executor             = $nextExec.executor
                    model                = $nextExec.model
                    reasoning_effort     = $nextExec.reasoningEffort
                    complexity_tier      = if ($nextExec.complexity) { $nextExec.complexity.tier } else { $null }
                    task_size_cached     = $sizeInfo.label
                    task_size_weight     = $sizeInfo.weight
                    task_priority_cached = $priorityInfo.label
                    task_priority_rank   = $priorityInfo.rank
                    is_dirty_resolution  = $isDirtyTask
                }
                $taskUrl = Get-TaskUrl -TaskId $task.id
                Add-RecentItem -ListName "SubmittedTasks" -Item @{
                    task_id      = $task.id
                    task_title   = $title
                    attempt_id   = $attempt.id
                    submitted_at = (Get-Date).ToString("o")
                    task_url     = $taskUrl
                }
                $seqValue = Get-SequenceValue -Title $task.title
                $state = Get-OrchestratorState
                if ($seqValue) {
                    $state.last_sequence_value = $seqValue
                }
                $state.last_task_id = $task.id
                $state.last_submitted_at = (Get-Date).ToString("o")
                Save-OrchestratorState -State $state
                $script:TasksSubmitted++
                $remainingCapacity -= 1  # Each task = 1 slot, weight only for model routing
                $started++
            }
        }
        else {
            Write-Log "[DRY-RUN] Would submit task $($task.id.Substring(0,8)) via $($nextExec.executor)/$($nextExec.model)$complexityTag (base: $targetBranch)" -Level "ACTION"
            # Still advance the cycling index in dry-run for accurate preview
            $null = Get-NextExecutorProfile
            $remainingCapacity -= 1  # Each task = 1 slot, weight only for model routing
            $started++
        }
    }

    if ($started -eq 0) {
        Write-Log "No tasks fit remaining capacity this cycle" -Level "INFO"
    }
}

function Test-BacklogEmpty {
    <#
    .SYNOPSIS Check if there are no more tasks to process.
    #>
    $todoTasks = Get-VKTasks -Status "todo" -Limit 1
    $hasTracked = $script:TrackedAttempts.Count -gt 0
    return (-not $todoTasks -or @($todoTasks).Count -eq 0) -and (-not $hasTracked)
}

# ─── Main Loop ────────────────────────────────────────────────────────────────

function Start-Orchestrator {
    Register-OrchestratorShutdownHandlers
    if (-not $WaitForMutex) {
        if (Get-EnvBool -Name "VE_ORCHESTRATOR_WAIT_FOR_MUTEX" -Default $false) {
            $WaitForMutex = $true
        }
    }
    do {
        $script:OrchestratorMutex = Enter-OrchestratorMutex
        if ($script:OrchestratorMutex) { break }

        if (-not $WaitForMutex) {
            Write-Log "Another orchestrator instance is already running. Exiting (mutex held)." -Level "WARN"
            return
        }

        if ($OneShot) {
            Write-Log "Another orchestrator instance is already running. Exiting." -Level "WARN"
            return
        }

        Write-Log "Another orchestrator instance is already running. Waiting ${PollIntervalSec}s before retry." -Level "WARN"
        if (-not (Start-InterruptibleSleep -Seconds $PollIntervalSec -Reason "mutex-wait")) { return }
    } while ($true)
    if (Test-OrchestratorStop) { return }
    try {
        Ensure-VeKanbanLibraryLoaded -RequiredFunctions $requiredFunctions | Out-Null
    }
    catch {
        Write-Log $_.Exception.Message -Level "ERROR"
        return
    }

    Write-Banner
    Ensure-GitIdentity
    Ensure-GitCredentialHelper
    Initialize-CISweepConfig
    Initialize-CISweepState

    # Validate prerequisites
    $ghVersion = gh --version 2>$null
    if (-not $ghVersion) {
        Write-Log "GitHub CLI (gh) not found. Install: https://cli.github.com/" -Level "ERROR"
        return
    }
    Write-Log "GitHub CLI: $($ghVersion | Select-Object -First 1)" -Level "INFO"

    $healthTimeout = [math]::Max(2, [math]::Min($VKApiTimeoutSec, 10))
    $healthBaseUrl = Get-VKBaseUrl
    $vkRetryDelay = 15  # First retry fast, then exponential backoff up to 300s
    while (-not (Test-VKApiReachable -TimeoutSec $healthTimeout)) {
        Write-Log "Vibe-kanban API not reachable at $healthBaseUrl. Waiting ${vkRetryDelay}s before retry." -Level "WARN"
        if ($OneShot) { return }
        if (-not (Start-InterruptibleSleep -Seconds $vkRetryDelay -Reason "vk-health")) { return }
        $vkRetryDelay = [math]::Min($vkRetryDelay * 2, 300)
    }

    if (-not (Get-Command Initialize-VKConfig -ErrorAction SilentlyContinue)) {
        $reloadPath = Resolve-VeKanbanLibraryPath
        if ($reloadPath) {
            Write-Log "Reloading ve-kanban library from $reloadPath" -Level "WARN"
            try {
                . $reloadPath
            }
            catch {
                Write-Log "Failed to reload ve-kanban library: $($_.Exception.Message)" -Level "ERROR"
                return
            }
        }
    }
    if (-not (Get-Command Initialize-VKConfig -ErrorAction SilentlyContinue)) {
        Write-Log "ve-kanban library not loaded (Initialize-VKConfig missing). Check scripts/ve-kanban.ps1 path." -Level "ERROR"
        return
    }

    if ($VKApiTimeoutSec -gt 0) {
        $global:PSDefaultParameterValues["Invoke-WebRequest:TimeoutSec"] = $VKApiTimeoutSec
        $global:PSDefaultParameterValues["Invoke-RestMethod:TimeoutSec"] = $VKApiTimeoutSec
        Write-Log "VK API timeout set to ${VKApiTimeoutSec}s" -Level "INFO"
    }

    # Auto-detect project and repo IDs
    $initOk = $false
    for ($attempt = 1; $attempt -le $VKApiRetryCount; $attempt++) {
        try {
            $initOk = Initialize-VKConfig
        }
        catch {
            $initOk = $false
            Write-Log "Initialize-VKConfig error: $($_.Exception.Message)" -Level "WARN"
        }
        if ($initOk) { break }
        if ($attempt -lt $VKApiRetryCount) {
            Write-Log "Retrying vibe-kanban init in ${VKApiRetryDelaySec}s (attempt $attempt/$VKApiRetryCount)" -Level "WARN"
            if (-not (Start-InterruptibleSleep -Seconds $VKApiRetryDelaySec -Reason "vk-init-retry")) { return }
        }
    }
    if (-not $initOk) {
        Write-Log "Failed to initialize vibe-kanban configuration after $VKApiRetryCount attempts" -Level "ERROR"
        return
    }
    $projectShort = Format-ShortId -Value $script:VK_PROJECT_ID
    $repoShort = Format-ShortId -Value $script:VK_REPO_ID
    if (-not $projectShort) { $projectShort = "unknown" }
    if (-not $repoShort) { $repoShort = "unknown" }
    Write-Log "Project: $projectShort...  Repo: $repoShort..." -Level "OK"

    # Log executor cycling setup
    Write-Log "Executors: $(($script:VK_EXECUTORS | ForEach-Object { "$($_.executor)/$($_.variant)" }) -join ' ⇄ ')" -Level "INFO"

    # Load persisted exclusion list from prior runs (prevents stale re-tracking after restart)
    Load-ProcessedAttemptIds

    # Initial sync
    Sync-TrackedAttempts
    $initialCounts = Get-TrackedStatusCounts
    Write-Log "Initial sync: $($script:TrackedAttempts.Count) tracked (running=$($initialCounts.running), review=$($initialCounts.review), error=$($initialCounts.error))" -Level "INFO"

    Write-Log "SyncCopilotState: seeding Copilot PR state" -Level "INFO"
    Sync-CopilotPRState

    if ($RunMergeStrategy) {
        Write-Log "RunMergeStrategy: merge-only mode" -Level "INFO"
        $candidates = Get-MergeCandidates
        if (-not $candidates -or @($candidates).Count -eq 0) {
            Write-Log "No merge candidates found" -Level "INFO"
            Write-Log "RunMergeStrategy complete" -Level "OK"
            return
        }

        $candidateList = $candidates | ForEach-Object { "#$($_.pr_number) ($($_.branch))" }
        Write-Log "Merge candidates: $($candidateList -join ', ')" -Level "INFO"

        $index = 0
        foreach ($candidate in $candidates) {
            $forceAdmin = $index -gt 0
            $adminLabel = if ($forceAdmin) { "admin" } else { "standard" }
            Write-Log "Merging PR #$($candidate.pr_number) [$adminLabel]" -Level "ACTION"
            if (-not $DryRun) {
                $mergeResult = Merge-PRWithFallback -PRNumber $candidate.pr_number -ForceAdmin:$forceAdmin
                if ($mergeResult.merged) {
                    if ($candidate.attempt_id -and $candidate.task_id) {
                        Complete-Task -AttemptId $candidate.attempt_id -TaskId $candidate.task_id -PRNumber $candidate.pr_number
                        $script:TrackedAttempts.Remove($candidate.attempt_id)
                        $script:ProcessedAttemptIds.Add($candidate.attempt_id) | Out-Null
                        Save-ProcessedAttemptIds
                    }
                    else {
                        Write-Log "Merged PR #$($candidate.pr_number) (no tracked attempt)" -Level "OK"
                    }
                }
                else {
                    Write-Log "Merge failed for PR #$($candidate.pr_number)" -Level "WARN"
                }
            }
            else {
                Write-Log "[DRY-RUN] Would merge PR #$($candidate.pr_number)" -Level "ACTION"
            }
            $index++
        }
        Write-Log "RunMergeStrategy complete" -Level "OK"
        return
    }

    try {
        do {
            if (Test-OrchestratorStop) { break }
            $script:CycleCount++
            Write-CycleSummary
            $counts = Get-TrackedStatusCounts
            Write-Log "Status: running=$($counts.running), review=$($counts.review), error=$($counts.error)" -Level "INFO"

            # Step 1: Sync attempt state from API
            Sync-TrackedAttempts
            if (Test-OrchestratorStop) { break }

            # Step 1b: Prune workspaces for already-completed/cancelled tasks
            Prune-CompletedTaskWorkspaces
            if (Test-OrchestratorStop) { break }

            # Step 2: Merge standalone Copilot PRs
            Process-StandaloneCopilotPRs
            if (Test-OrchestratorStop) { break }

            # Step 2b: Close stale Copilot fix PRs
            Close-StaleCopilotPRs
            if (Test-OrchestratorStop) { break }

            # Step 3: Process completed attempts (check PRs, merge, mark done)
            Process-CompletedAttempts
            if (Test-OrchestratorStop) { break }

            # Step 3b: Send queued follow-ups before starting new tasks
            Process-PendingFollowUps
            if (Test-OrchestratorStop) { break }

            # Step 3c: Codex SDK takeover for tasks exceeding follow-up threshold
            Process-CodexTakeoverJobs
            if (Test-OrchestratorStop) { break }

            # Step 3d: Process anomaly signals from the monitor's anomaly detector
            Process-AnomalySignals
            if (Test-OrchestratorStop) { break }

            # Step 4: Fill empty parallel slots with new task submissions
            if (Test-GlobalPause) {
                $pauseState = Get-GlobalPauseState
                $reason = if ($pauseState.reason) { " ($($pauseState.reason))" } else { "" }
                Write-Log "Global pause active$reason — skipping new task dispatch this cycle" -Level "WARN"
            }
            elseif (@(Get-PendingFollowUpAttempts).Count -eq 0) {
                Fill-ParallelSlots
            }

            # Step 5: Check if we're done
            if (Test-BacklogEmpty) {
                Write-Log "All tasks completed! Backlog empty, no active attempts." -Level "OK"
                Write-Host ""
                Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
                Write-Host "  ║   ALL TASKS COMPLETE                    ║" -ForegroundColor Green
                Write-Host "  ║   Submitted: $($script:TasksSubmitted.ToString().PadRight(28))║" -ForegroundColor Green
                Write-Host "  ║   Completed: $($script:TasksCompleted.ToString().PadRight(28))║" -ForegroundColor Green
                Write-Host "  ║   Cycles:    $($script:CycleCount.ToString().PadRight(28))║" -ForegroundColor Green
                $successLine = Get-SuccessRateSummary
                Write-Host "  ║   $($successLine.PadRight(39))║" -ForegroundColor Green
                Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
                Write-Host ""
                break
            }

            if ($OneShot) {
                Write-Log "OneShot mode — exiting after single cycle" -Level "INFO"
                break
            }

            # Step 6: Wait before next cycle
            Write-Log "Sleeping ${PollIntervalSec}s until next cycle... (Ctrl+C to stop)" -Level "INFO"
            if (-not (Start-InterruptibleSleep -Seconds $PollIntervalSec -Reason "cycle-wait")) { break }
 
            Save-StatusSnapshot

        } while ($true)
    }
    finally {
        if ($script:OrchestratorMutex -and
            $script:OrchestratorMutex -is [System.Threading.Mutex]) {
            try { $script:OrchestratorMutex.ReleaseMutex() } catch { }
            try { $script:OrchestratorMutex.Dispose() } catch { }
            $script:OrchestratorMutex = $null
        }
    }
}

# ─── Entry Point ──────────────────────────────────────────────────────────────
Start-Orchestrator

# Ensure clean exit code — without this, PowerShell propagates $LASTEXITCODE
# from the last native command (git, gh) which may be non-zero even on normal
# orchestrator shutdown, causing the monitor to trigger autofix unnecessarily.
exit 0
