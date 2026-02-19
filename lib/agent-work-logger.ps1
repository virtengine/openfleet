# Agent Work Logger - Capture all agent work to structured logs
# Usage: Import this module in ve-orchestrator.ps1 and call logging functions

# ── Configuration ───────────────────────────────────────────────────────────
$LogDir = Join-Path $PSScriptRoot "..\..\..\.cache\agent-work-logs"
$StreamLogPath = Join-Path $LogDir "agent-work-stream.jsonl"
$ErrorLogPath = Join-Path $LogDir "agent-errors.jsonl"
$MetricsLogPath = Join-Path $LogDir "agent-metrics.jsonl"
$SessionLogDir = Join-Path $LogDir "agent-sessions"
$AlertsLogPath = Join-Path $LogDir "agent-alerts.jsonl"

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
if (-not (Test-Path $SessionLogDir)) {
    New-Item -ItemType Directory -Path $SessionLogDir -Force | Out-Null
}

# Session tracking
$script:SessionStartTimes = @{}
$script:SessionMetadata = @{}

# ── Core Logging Functions ──────────────────────────────────────────────────

function Write-AgentWorkLog {
    <#
    .SYNOPSIS
    Write an event to the agent work stream log

    .PARAMETER AttemptId
    The VK attempt ID (workspace ID)

    .PARAMETER EventType
    Type of event: session_start, session_end, agent_output, error, tool_call, followup_sent

    .PARAMETER Data
    Event-specific data payload (hashtable)

    .PARAMETER TaskMetadata
    Optional task metadata (task_id, title, description, project_id)

    .PARAMETER ExecutorInfo
    Optional executor info (executor, variant, model)

    .PARAMETER GitContext
    Optional git context (branch, base_branch, commits_ahead, commits_behind)
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [Parameter(Mandatory)]
        [ValidateSet('session_start', 'session_end', 'agent_output', 'agent_thinking',
                     'tool_call', 'tool_result', 'error', 'followup_sent', 'status_change')]
        [string]$EventType,

        [Parameter(Mandatory)]
        [hashtable]$Data,

        [hashtable]$TaskMetadata,
        [hashtable]$ExecutorInfo,
        [hashtable]$GitContext
    )

    $timestamp = (Get-Date).ToUniversalTime().ToString("o")

    # Build log entry
    $logEntry = @{
        timestamp = $timestamp
        attempt_id = $AttemptId
        event_type = $EventType
        data = $Data
    }

    # Add optional metadata
    if ($TaskMetadata) {
        $logEntry.task_id = $TaskMetadata.task_id
        $logEntry.task_title = $TaskMetadata.task_title
        $logEntry.task_description = $TaskMetadata.task_description
        $logEntry.project_id = $TaskMetadata.project_id
    }

    if ($ExecutorInfo) {
        $logEntry.executor = $ExecutorInfo.executor
        $logEntry.executor_variant = $ExecutorInfo.executor_variant
        $logEntry.model = $ExecutorInfo.model
    }

    if ($GitContext) {
        $logEntry.branch = $GitContext.branch
        $logEntry.base_branch = $GitContext.base_branch
        $logEntry.commits_ahead = $GitContext.commits_ahead
        $logEntry.commits_behind = $GitContext.commits_behind
    }

    # Add elapsed time if session exists
    if ($script:SessionStartTimes.ContainsKey($AttemptId)) {
        $elapsed = (Get-Date) - $script:SessionStartTimes[$AttemptId]
        $logEntry.elapsed_ms = [int]$elapsed.TotalMilliseconds
    }

    # Serialize to JSONL (compact, single-line)
    $jsonLine = ($logEntry | ConvertTo-Json -Compress -Depth 10)

    # Append to main stream log (thread-safe)
    $mutex = New-Object System.Threading.Mutex($false, "AgentWorkStreamLog")
    try {
        [void]$mutex.WaitOne()
        Add-Content -Path $StreamLogPath -Value $jsonLine -Encoding UTF8
    }
    finally {
        $mutex.ReleaseMutex()
    }

    # Append to session-specific log
    $sessionLogPath = Join-Path $SessionLogDir "$AttemptId.jsonl"
    Add-Content -Path $sessionLogPath -Value $jsonLine -Encoding UTF8

    # If error event, also write to error-only log
    if ($EventType -eq 'error') {
        Add-Content -Path $ErrorLogPath -Value $jsonLine -Encoding UTF8
    }
}

function Start-AgentSession {
    <#
    .SYNOPSIS
    Log the start of an agent session
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [Parameter(Mandatory)]
        [hashtable]$TaskMetadata,

        [Parameter(Mandatory)]
        [hashtable]$ExecutorInfo,

        [hashtable]$GitContext,

        [string]$Prompt,
        [string]$PromptType = "initial",
        [string]$FollowupReason
    )

    # Track session start time
    $script:SessionStartTimes[$AttemptId] = Get-Date

    # Store session metadata for later use
    $script:SessionMetadata[$AttemptId] = @{
        TaskMetadata = $TaskMetadata
        ExecutorInfo = $ExecutorInfo
        GitContext = $GitContext
    }

    # Build data payload
    $data = @{
        prompt_type = $PromptType
    }

    if ($Prompt) { $data.prompt = $Prompt }
    if ($FollowupReason) { $data.followup_reason = $FollowupReason }

    Write-AgentWorkLog -AttemptId $AttemptId -EventType "session_start" `
        -Data $data -TaskMetadata $TaskMetadata -ExecutorInfo $ExecutorInfo `
        -GitContext $GitContext

    Write-Host "[agent-logger] Session started: $AttemptId ($($ExecutorInfo.executor))" -ForegroundColor Cyan
}

function Stop-AgentSession {
    <#
    .SYNOPSIS
    Log the end of an agent session with metrics
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [Parameter(Mandatory)]
        [ValidateSet('success', 'failed', 'timeout', 'interrupted')]
        [string]$CompletionStatus,

        [int]$TotalTokens,
        [double]$CostUSD,
        [hashtable]$Outcome
    )

    # Calculate duration
    $duration = 0
    if ($script:SessionStartTimes.ContainsKey($AttemptId)) {
        $elapsed = (Get-Date) - $script:SessionStartTimes[$AttemptId]
        $duration = [int]$elapsed.TotalMilliseconds
    }

    # Build data payload
    $data = @{
        completion_status = $CompletionStatus
        duration_ms = $duration
    }

    if ($TotalTokens) { $data.total_tokens = $TotalTokens }
    if ($CostUSD) { $data.cost_usd = $CostUSD }
    if ($Outcome) { $data.outcome = $Outcome }

    # Get stored metadata
    $metadata = $script:SessionMetadata[$AttemptId]

    Write-AgentWorkLog -AttemptId $AttemptId -EventType "session_end" `
        -Data $data -TaskMetadata $metadata.TaskMetadata `
        -ExecutorInfo $metadata.ExecutorInfo -GitContext $metadata.GitContext

    # Write session metrics to metrics log
    Write-AgentSessionMetrics -AttemptId $AttemptId -CompletionStatus $CompletionStatus `
        -DurationMs $duration -TotalTokens $TotalTokens -CostUSD $CostUSD -Outcome $Outcome

    # Cleanup
    $script:SessionStartTimes.Remove($AttemptId)
    $script:SessionMetadata.Remove($AttemptId)

    Write-Host "[agent-logger] Session ended: $AttemptId ($CompletionStatus, $($duration)ms)" -ForegroundColor Cyan
}

function Write-AgentError {
    <#
    .SYNOPSIS
    Log an error encountered by an agent
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [Parameter(Mandatory)]
        [string]$ErrorMessage,

        [string]$ErrorFingerprint,
        [string]$ErrorCategory,
        [string]$StackTrace
    )

    $data = @{
        error_message = $ErrorMessage
    }

    if ($ErrorFingerprint) { $data.error_fingerprint = $ErrorFingerprint }
    if ($ErrorCategory) { $data.error_category = $ErrorCategory }
    if ($StackTrace) { $data.stack_trace = $StackTrace }

    # Get stored metadata
    $metadata = $script:SessionMetadata[$AttemptId]

    Write-AgentWorkLog -AttemptId $AttemptId -EventType "error" `
        -Data $data -TaskMetadata $metadata.TaskMetadata `
        -ExecutorInfo $metadata.ExecutorInfo -GitContext $metadata.GitContext

    Write-Host "[agent-logger] Error logged: $AttemptId - $ErrorFingerprint" -ForegroundColor Red
}

function Write-AgentFollowup {
    <#
    .SYNOPSIS
    Log a followup message sent to an agent
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [Parameter(Mandatory)]
        [string]$Message,

        [string]$Reason
    )

    $data = @{
        prompt = $Message
    }

    if ($Reason) { $data.followup_reason = $Reason }

    # Get stored metadata
    $metadata = $script:SessionMetadata[$AttemptId]

    Write-AgentWorkLog -AttemptId $AttemptId -EventType "followup_sent" `
        -Data $data -TaskMetadata $metadata.TaskMetadata `
        -ExecutorInfo $metadata.ExecutorInfo -GitContext $metadata.GitContext

    Write-Host "[agent-logger] Followup sent: $AttemptId - $Reason" -ForegroundColor Yellow
}

function Write-AgentStatusChange {
    <#
    .SYNOPSIS
    Log a status change for an attempt
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [Parameter(Mandatory)]
        [string]$OldStatus,

        [Parameter(Mandatory)]
        [string]$NewStatus,

        [string]$Reason
    )

    $data = @{
        old_status = $OldStatus
        new_status = $NewStatus
    }

    if ($Reason) { $data.reason = $Reason }

    # Get stored metadata (may not exist for old attempts)
    $metadata = $script:SessionMetadata[$AttemptId]

    Write-AgentWorkLog -AttemptId $AttemptId -EventType "status_change" `
        -Data $data -TaskMetadata $metadata.TaskMetadata `
        -ExecutorInfo $metadata.ExecutorInfo -GitContext $metadata.GitContext
}

# ── Session Metrics ─────────────────────────────────────────────────────────

function Write-AgentSessionMetrics {
    <#
    .SYNOPSIS
    Write aggregated metrics for a completed session
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AttemptId,

        [string]$CompletionStatus,
        [int]$DurationMs,
        [int]$TotalTokens,
        [double]$CostUSD,
        [hashtable]$Outcome
    )

    $metadata = $script:SessionMetadata[$AttemptId]
    if (-not $metadata) { return }

    # Count errors from session log
    $sessionLogPath = Join-Path $SessionLogDir "$AttemptId.jsonl"
    $errorCount = 0
    $errorCategories = @()
    $errorFingerprints = @()

    if (Test-Path $sessionLogPath) {
        $sessionEvents = Get-Content $sessionLogPath | ForEach-Object {
            $_ | ConvertFrom-Json
        }

        $errors = $sessionEvents | Where-Object { $_.event_type -eq 'error' }
        $errorCount = $errors.Count
        $errorCategories = $errors | ForEach-Object { $_.data.error_category } | Where-Object { $_ } | Select-Object -Unique
        $errorFingerprints = $errors | ForEach-Object { $_.data.error_fingerprint } | Where-Object { $_ } | Select-Object -Unique
    }

    # Build metrics entry
    $metricsEntry = @{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        attempt_id = $AttemptId
        task_id = $metadata.TaskMetadata.task_id
        executor = $metadata.ExecutorInfo.executor
        model = $metadata.ExecutorInfo.model

        metrics = @{
            duration_ms = $DurationMs
            total_tokens = $TotalTokens
            cost_usd = $CostUSD
            errors = $errorCount
        }

        outcome = $Outcome

        error_summary = @{
            total_errors = $errorCount
            error_categories = $errorCategories
            error_fingerprints = $errorFingerprints
        }
    }

    # Serialize and append
    $jsonLine = ($metricsEntry | ConvertTo-Json -Compress -Depth 10)
    Add-Content -Path $MetricsLogPath -Value $jsonLine -Encoding UTF8
}

# ── Helper Functions ────────────────────────────────────────────────────────

function Get-SessionMetrics {
    <#
    .SYNOPSIS
    Get aggregated metrics from all session logs
    #>
    param(
        [int]$LastNDays = 7
    )

    $cutoffDate = (Get-Date).AddDays(-$LastNDays)

    if (-not (Test-Path $MetricsLogPath)) {
        return @()
    }

    Get-Content $MetricsLogPath | ForEach-Object {
        $entry = $_ | ConvertFrom-Json
        $timestamp = [DateTime]::Parse($entry.timestamp)

        if ($timestamp -ge $cutoffDate) {
            [PSCustomObject]$entry
        }
    }
}

function Get-ErrorClusters {
    <#
    .SYNOPSIS
    Cluster errors by fingerprint from error log
    #>
    param(
        [int]$LastNDays = 7,
        [int]$TopN = 10
    )

    $cutoffDate = (Get-Date).AddDays(-$LastNDays)

    if (-not (Test-Path $ErrorLogPath)) {
        return @()
    }

    $errors = Get-Content $ErrorLogPath | ForEach-Object {
        $entry = $_ | ConvertFrom-Json
        $timestamp = [DateTime]::Parse($entry.timestamp)

        if ($timestamp -ge $cutoffDate) {
            $entry
        }
    }

    # Group by fingerprint
    $grouped = $errors | Group-Object -Property { $_.data.error_fingerprint }

    $clusters = $grouped | ForEach-Object {
        $fingerprint = $_.Name
        $events = $_.Group

        [PSCustomObject]@{
            Fingerprint = $fingerprint
            Count = $events.Count
            AffectedTasks = ($events | Select-Object -ExpandProperty task_id -Unique).Count
            FirstSeen = ($events | Sort-Object timestamp | Select-Object -First 1).timestamp
            LastSeen = ($events | Sort-Object timestamp | Select-Object -Last 1).timestamp
            SampleMessage = ($events | Select-Object -First 1).data.error_message
        }
    } | Sort-Object Count -Descending | Select-Object -First $TopN

    return $clusters
}

function Show-AgentWorkSummary {
    <#
    .SYNOPSIS
    Display a summary of recent agent work
    #>
    param(
        [int]$LastNDays = 7
    )

    Write-Host "`n=== Agent Work Summary (Last $LastNDays Days) ===" -ForegroundColor Cyan

    # Get metrics
    $metrics = Get-SessionMetrics -LastNDays $LastNDays

    if ($metrics.Count -eq 0) {
        Write-Host "No session data found" -ForegroundColor Yellow
        return
    }

    # Aggregate stats
    $totalSessions = $metrics.Count
    $successSessions = ($metrics | Where-Object { $_.outcome.status -eq 'completed' }).Count
    $avgDuration = ($metrics | Measure-Object -Property { $_.metrics.duration_ms } -Average).Average
    $totalCost = ($metrics | Measure-Object -Property { $_.metrics.cost_usd } -Sum).Sum
    $totalErrors = ($metrics | Measure-Object -Property { $_.metrics.errors } -Sum).Sum

    Write-Host "`nOverall Metrics:" -ForegroundColor Green
    Write-Host "  Total Sessions: $totalSessions"
    Write-Host "  Success Rate: $([math]::Round($successSessions * 100.0 / $totalSessions, 1))%"
    Write-Host "  Avg Duration: $([math]::Round($avgDuration / 1000, 1))s"
    Write-Host "  Total Cost: `$$([math]::Round($totalCost, 2))"
    Write-Host "  Total Errors: $totalErrors"

    # Executor comparison
    $byExecutor = $metrics | Group-Object -Property executor

    Write-Host "`nBy Executor:" -ForegroundColor Green
    foreach ($group in $byExecutor) {
        $executor = $group.Name
        $count = $group.Count
        $successRate = ($group.Group | Where-Object { $_.outcome.status -eq 'completed' }).Count * 100.0 / $count

        Write-Host "  ${executor}: $count sessions, $([math]::Round($successRate, 1))% success"
    }

    # Top errors
    $errorClusters = Get-ErrorClusters -LastNDays $LastNDays -TopN 5

    if ($errorClusters.Count -gt 0) {
        Write-Host "`nTop Errors:" -ForegroundColor Red
        foreach ($cluster in $errorClusters) {
            Write-Host "  $($cluster.Fingerprint): $($cluster.Count) occurrences"
            Write-Host "    Sample: $($cluster.SampleMessage.Substring(0, [Math]::Min(80, $cluster.SampleMessage.Length)))..."
        }
    }

    Write-Host ""
}

# ── Exports ─────────────────────────────────────────────────────────────────
# Only call Export-ModuleMember when loaded as a module (Import-Module).
# When dot-sourced, all functions are already visible in the caller's scope.
if ($MyInvocation.MyCommand.ScriptBlock.Module) {
    Export-ModuleMember -Function @(
        'Write-AgentWorkLog',
        'Start-AgentSession',
        'Stop-AgentSession',
        'Write-AgentError',
        'Write-AgentFollowup',
        'Write-AgentStatusChange',
        'Get-SessionMetrics',
        'Get-ErrorClusters',
        'Show-AgentWorkSummary'
    )
}
