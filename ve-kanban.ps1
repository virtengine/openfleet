#!/usr/bin/env pwsh
<#
.SYNOPSIS
    VirtEngine Kanban CLI — wraps the vibe-kanban HTTP API for task + attempt management.

.DESCRIPTION
    Provides commands to list tasks, submit task attempts, check attempt status,
    rebase attempts, merge PRs, and mark tasks as complete. Designed to be both
    a standalone CLI and a dot-sourceable library for ve-orchestrator.ps1.

.EXAMPLE
    # List todo tasks
    ./ve-kanban.ps1 list --status todo

    # Submit the next N tasks as attempts
    ./ve-kanban.ps1 submit-next --count 2

    # Show active attempts
    ./ve-kanban.ps1 status

    # Merge a completed PR
    ./ve-kanban.ps1 merge --branch ve/abc1-feat-portal

    # Run orchestration loop
    ./ve-kanban.ps1 orchestrate --parallel 2
#>

# ─── Configuration ────────────────────────────────────────────────────────────
$script:VK_BASE_URL = $env:VK_ENDPOINT_URL ?? $env:VK_BASE_URL ?? "http://127.0.0.1:54089"
$script:VK_PROJECT_NAME = $env:VK_PROJECT_NAME ?? "virtengine"
$script:VK_PROJECT_ID = $env:VK_PROJECT_ID ?? ""   # Auto-detected if empty
$script:VK_REPO_ID = $env:VK_REPO_ID ?? ""   # Auto-detected if empty
$script:GH_OWNER = $env:GH_OWNER ?? "virtengine"
$script:GH_REPO = $env:GH_REPO ?? "virtengine"
$script:VK_TARGET_BRANCH = $env:VK_TARGET_BRANCH ?? "origin/main"
$script:VK_INITIALIZED = $false
$script:VK_LAST_GH_ERROR = $null
$script:VK_LAST_GH_ERROR_AT = $null
$script:VK_CLI_RAW_LINE = $null

# Executor profiles (used for 50/50 cycling between Codex and Copilot)
$script:VK_EXECUTORS = @(
    @{ executor = "CODEX"; variant = "DEFAULT" }
    @{ executor = "COPILOT"; variant = "CLAUDE_OPUS_4_6" }
)
$script:VK_EXECUTOR_INDEX = (Get-Random -Minimum 0 -Maximum $script:VK_EXECUTORS.Count)   # Random start for session diversity

# ─── HTTP Helpers ─────────────────────────────────────────────────────────────

function Invoke-VKApi {
    <#
    .SYNOPSIS Invoke the vibe-kanban REST API.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = "GET",
        [object]$Body
    )
    $uri = "$script:VK_BASE_URL$Path"
    $params = @{ Uri = $uri; Method = $Method; ContentType = "application/json"; UseBasicParsing = $true }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
    try {
        $raw = Invoke-WebRequest @params -ErrorAction Stop
        $resp = $raw.Content | ConvertFrom-Json -Depth 20
        if ($resp.success -eq $false) {
            Write-Warning "API error on $Path : $($resp.message)"
            return $null
        }
        return $resp.data ?? $resp
    }
    catch {
        Write-Error "HTTP $Method $uri failed: $_"
        return $null
    }
}

# ─── Copilot Cloud Guard ─────────────────────────────────────────────────────

function Test-CopilotCloudDisabled {
    $flag = $env:COPILOT_CLOUD_DISABLED
    if ($flag -and $flag.ToString().ToLower() -in @("1", "true", "yes")) {
        return $true
    }
    $untilRaw = $env:COPILOT_CLOUD_DISABLED_UNTIL
    if (-not $untilRaw) { return $false }
    try {
        $until = [datetimeoffset]::Parse($untilRaw).ToLocalTime().DateTime
        if ((Get-Date) -lt $until) { return $true }
    }
    catch {
        return $false
    }
    return $false
}

# ─── Auto-Detection & Initialization ─────────────────────────────────────────

function Initialize-VKConfig {
    <#
    .SYNOPSIS Auto-detect project ID and repo ID from vibe-kanban by project name.
              Works for any user with their own vibe-kanban setup.
    #>
    if ($script:VK_INITIALIZED) { return $true }

    # If project ID already set (via env), skip auto-detection for project
    if ($script:VK_PROJECT_ID) {
        Write-Verbose "Using configured project ID: $script:VK_PROJECT_ID"
    }
    else {
        Write-Host "  Auto-detecting project '$script:VK_PROJECT_NAME'..." -ForegroundColor DarkGray
        $projects = Invoke-VKApi -Path "/api/projects"
        if (-not $projects) {
            Write-Error "Cannot connect to vibe-kanban at $script:VK_BASE_URL"
            return $false
        }
        $projectList = if ($projects -is [System.Array]) { $projects } elseif ($projects.projects) { $projects.projects } else { @($projects) }

        # Find project by name (case-insensitive)
        $match = $projectList | Where-Object {
            $_.name -ieq $script:VK_PROJECT_NAME -or
            $_.display_name -ieq $script:VK_PROJECT_NAME -or
            $_.title -ieq $script:VK_PROJECT_NAME
        } | Select-Object -First 1

        if (-not $match) {
            Write-Error "No project named '$script:VK_PROJECT_NAME' found. Available: $($projectList | ForEach-Object { $_.name ?? $_.display_name ?? $_.title } | Join-String -Separator ', ')"
            return $false
        }
        $script:VK_PROJECT_ID = $match.id
        Write-Host "  ✓ Project: $($match.name ?? $match.display_name ?? $match.title) ($($script:VK_PROJECT_ID.Substring(0,8))...)" -ForegroundColor Green
    }

    # Auto-detect repo ID if not set
    if (-not $script:VK_REPO_ID) {
        Write-Host "  Auto-detecting repository..." -ForegroundColor DarkGray
        $repos = Invoke-VKApi -Path "/api/repos?project_id=$script:VK_PROJECT_ID"
        if (-not $repos) {
            # Try alternate endpoint
            $repos = Invoke-VKApi -Path "/api/projects/$script:VK_PROJECT_ID/repos"
        }
        $repoList = if ($repos -is [System.Array]) { $repos } elseif ($repos.repos) { $repos.repos } else { @($repos) }

        if ($repoList -and @($repoList).Count -gt 0) {
            # Prefer repo matching GH_REPO name, otherwise take first
            $repoMatch = $repoList | Where-Object { $_.name -ieq $script:GH_REPO } | Select-Object -First 1
            if (-not $repoMatch) { $repoMatch = $repoList | Select-Object -First 1 }
            $script:VK_REPO_ID = $repoMatch.id
            Write-Host "  ✓ Repo: $($repoMatch.name ?? 'default') ($($script:VK_REPO_ID.Substring(0,8))...)" -ForegroundColor Green
        }
        else {
            Write-Warning "No repos found for project. Repo ID must be set via VK_REPO_ID env var."
            return $false
        }
    }

    $script:VK_INITIALIZED = $true
    return $true
}

# ─── Executor Cycling ─────────────────────────────────────────────────────────

function Get-NextExecutorProfile {
    <#
    .SYNOPSIS Get the next executor profile in the 50/50 Codex/Copilot rotation.
    #>
    $max = $script:VK_EXECUTORS.Count
    if ($max -le 1) {
        return $script:VK_EXECUTORS[0]
    }
    for ($i = 0; $i -lt $max; $i++) {
        $profile = $script:VK_EXECUTORS[$script:VK_EXECUTOR_INDEX]
        $script:VK_EXECUTOR_INDEX = ($script:VK_EXECUTOR_INDEX + 1) % $script:VK_EXECUTORS.Count
        if ((Test-CopilotCloudDisabled) -and $profile.executor -eq "COPILOT") {
            continue
        }
        return $profile
    }
    return $script:VK_EXECUTORS[0]
}

function Get-CurrentExecutorProfile {
    <#
    .SYNOPSIS Peek at the next executor profile without advancing the cycle.
    #>
    return $script:VK_EXECUTORS[$script:VK_EXECUTOR_INDEX]
}

# ─── Task Functions ───────────────────────────────────────────────────────────

function Get-VKTasks {
    <#
    .SYNOPSIS List tasks with optional status filter (client-side filtering).
    #>
    [CmdletBinding()]
    param(
        [ValidateSet("todo", "inprogress", "inreview", "done", "cancelled")]
        [string]$Status,
        [int]$Limit = 500
    )
    if (-not (Initialize-VKConfig)) { return @() }
    $result = Invoke-VKApi -Path "/api/tasks?project_id=$script:VK_PROJECT_ID"
    if (-not $result) { return @() }
    # Result is either the tasks array directly, or an object with .tasks
    $tasks = if ($result -is [System.Array]) { $result } elseif ($result.tasks) { $result.tasks } else { @($result) }
    # API doesn't filter server-side, so filter client-side
    if ($Status -and $tasks) {
        $tasks = @($tasks | Where-Object { $_.status -eq $Status })
    }
    return $tasks
}

function Get-VKTask {
    <#
    .SYNOPSIS Get a single task by ID.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaskId)
    return Invoke-VKApi -Path "/api/tasks/$TaskId"
}

function Create-VKTask {
    <#
    .SYNOPSIS Create a new task in vibe-kanban.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Description,
        [ValidateSet("todo", "inprogress", "inreview", "done", "cancelled")]
        [string]$Status = "todo"
    )
    if (-not (Initialize-VKConfig)) { return $null }
    $body = @{
        title       = $Title
        description = $Description
        status      = $Status
        project_id  = $script:VK_PROJECT_ID
    }
    return Invoke-VKApi -Path "/api/tasks" -Method "POST" -Body $body
}

function Update-VKTaskStatus {
    <#
    .SYNOPSIS Update a task's status.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskId,
        [Parameter(Mandatory)]
        [ValidateSet("todo", "inprogress", "inreview", "done", "cancelled")]
        [string]$Status
    )
    return Invoke-VKApi -Path "/api/tasks/$TaskId" -Method "PUT" -Body @{ status = $Status }
}

function Get-VKNextTodoTasks {
    <#
    .SYNOPSIS Get the next N tasks in 'todo' status, ordered by creation date (earliest first = highest priority).
    #>
    [CmdletBinding()]
    param([int]$Count = 1)
    $tasks = Get-VKTasks -Status "todo" -Limit $Count
    if (-not $tasks) { return @() }
    # Return as array
    $arr = @($tasks)
    return $arr | Select-Object -First $Count
}

# ─── Attempt Functions ────────────────────────────────────────────────────────

function Get-VKAttempts {
    <#
    .SYNOPSIS List all task attempts.
    #>
    [CmdletBinding()]
    param([switch]$ActiveOnly)
    $result = Invoke-VKApi -Path "/api/task-attempts"
    if (-not $result) { return @() }
    $attempts = if ($result -is [System.Array]) { @($result) } else { @($result) }
    if ($ActiveOnly) {
        $attempts = @($attempts | Where-Object { -not $_.archived })
    }
    return $attempts
}

function Get-VKAttemptSummaries {
    <#
    .SYNOPSIS Get attempt summaries for workspace status (idle/running/failed).
    #>
    [CmdletBinding()]
    param([bool]$Archived = $false)
    $body = @{ archived = $Archived }
    $result = Invoke-VKApi -Path "/api/task-attempts/summary" -Method "POST" -Body $body
    if (-not $result) { return @() }
    $summaries = if ($result.summaries) { $result.summaries } else { $result }
    return @($summaries)
}

function Get-VKArchivedAttempts {
    <#
    .SYNOPSIS List archived task attempts.
    #>
    [CmdletBinding()]
    $attempts = Get-VKAttempts
    if (-not $attempts) { return @() }
    return @($attempts | Where-Object { $_.archived })
}

function Submit-VKTaskAttempt {
    <#
    .SYNOPSIS Submit a task as a new attempt (creates worktree + starts agent).
              Uses the next executor in the Codex/Copilot rotation cycle.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskId,
        [string]$TargetBranch = $script:VK_TARGET_BRANCH,
        [hashtable]$ExecutorOverride
    )
    if (-not (Initialize-VKConfig)) { return $null }

    # Use override if provided, otherwise cycle to next executor
    $execProfile = if ($ExecutorOverride) { $ExecutorOverride } else { Get-NextExecutorProfile }

    $body = @{
        task_id             = $TaskId
        repos               = @(
            @{
                repo_id       = $script:VK_REPO_ID
                target_branch = $TargetBranch
            }
        )
        executor_profile_id = @{
            executor = $execProfile.executor
            variant  = $execProfile.variant
        }
    }
    Write-Host "  Submitting attempt for task $TaskId ($($execProfile.executor)/$($execProfile.variant)) ..." -ForegroundColor Cyan
    $result = Invoke-VKApi -Path "/api/task-attempts" -Method "POST" -Body $body
    if ($result) {
        Write-Host "  ✓ Attempt created: $($result.id) → branch $($result.branch)" -ForegroundColor Green
    }
    return $result
}

function Invoke-VKRebase {
    <#
    .SYNOPSIS Rebase an attempt's branch onto the latest target.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AttemptId,
        [string]$BaseBranch = $script:VK_TARGET_BRANCH
    )
    $body = @{
        repo_id         = $script:VK_REPO_ID
        old_base_branch = $BaseBranch
        new_base_branch = $BaseBranch
    }
    return Invoke-VKApi -Path "/api/task-attempts/$AttemptId/rebase" -Method "POST" -Body $body
}

function Archive-VKAttempt {
    <#
    .SYNOPSIS Archive a task attempt so it no longer counts as active.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AttemptId)
    $body = @{ archived = $true }
    return Invoke-VKApi -Path "/api/task-attempts/$AttemptId" -Method "PUT" -Body $body
}

function Unarchive-VKAttempt {
    <#
    .SYNOPSIS Unarchive a task attempt so it counts as active again.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AttemptId)
    $body = @{ archived = $false }
    return Invoke-VKApi -Path "/api/task-attempts/$AttemptId" -Method "PUT" -Body $body
}

# ─── GitHub PR Functions ─────────────────────────────────────────────────────

function Set-VKLastGithubError {
    param(
        [string]$Type,
        [string]$Message
    )
    $script:VK_LAST_GH_ERROR = @{ type = $Type; message = $Message }
    $script:VK_LAST_GH_ERROR_AT = Get-Date
}

function Clear-VKLastGithubError {
    $script:VK_LAST_GH_ERROR = $null
    $script:VK_LAST_GH_ERROR_AT = $null
}

function Get-VKLastGithubError {
    return $script:VK_LAST_GH_ERROR
}

function Invoke-VKGithub {
    <#
    .SYNOPSIS Invoke gh CLI with rate-limit detection.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Args
    )
    $output = & gh @Args 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        if ($output -match "rate limit|API rate limit exceeded|secondary rate limit|abuse detection") {
            Set-VKLastGithubError -Type "rate_limit" -Message $output
        }
        else {
            Set-VKLastGithubError -Type "error" -Message $output
        }
        return $null
    }
    Clear-VKLastGithubError
    return $output
}

function Get-PRForBranch {
    <#
    .SYNOPSIS Find an open or merged PR for a given branch.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Branch)
    $prJson = Invoke-VKGithub -Args @(
        "pr", "list", "--head", $Branch, "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--json", "number,state,title,mergeable,statusCheckRollup,mergedAt,createdAt,url",
        "--limit", "1"
    )
    if (-not $prJson -or $prJson -eq "[]") {
        # Also check merged/closed
        $prJson = Invoke-VKGithub -Args @(
            "pr", "list", "--head", $Branch, "--repo", "$script:GH_OWNER/$script:GH_REPO",
            "--state", "merged", "--json", "number,state,title,mergedAt,createdAt,url",
            "--limit", "1"
        )
    }
    if (-not $prJson -or $prJson -eq "[]") { return $null }
    return ($prJson | ConvertFrom-Json) | Select-Object -First 1
}

function Get-PRCheckStatus {
    <#
    .SYNOPSIS Get CI check status for a PR.
    .OUTPUTS "passing", "failing", "pending", or "unknown"
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $checksJson = Invoke-VKGithub -Args @(
        "pr", "checks", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--json", "name,state"
    )
    if (-not $checksJson) { return "unknown" }
    $checks = $checksJson | ConvertFrom-Json
    if (-not $checks -or $checks.Count -eq 0) { return "unknown" }

    $failing = $checks | Where-Object { $_.state -in @("FAILURE", "ERROR") }
    $pending = $checks | Where-Object { $_.state -in @("PENDING", "IN_PROGRESS", "QUEUED") }

    if ($failing.Count -gt 0) { return "failing" }
    if ($pending.Count -gt 0) { return "pending" }
    return "passing"
}

function Get-PRLatestCheckTimestamp {
    <#
    .SYNOPSIS Get the most recent check started/completed time for a PR.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $checksJson = Invoke-VKGithub -Args @(
        "pr", "checks", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--json", "name,state,startedAt,completedAt"
    )
    if (-not $checksJson) { return $null }
    $checks = $checksJson | ConvertFrom-Json
    if (-not $checks -or $checks.Count -eq 0) { return $null }

    $timestamps = @()
    foreach ($check in $checks) {
        if ($check.startedAt) { $timestamps += [datetime]$check.startedAt }
        if ($check.completedAt) { $timestamps += [datetime]$check.completedAt }
    }
    if ($timestamps.Count -eq 0) { return $null }
    return ($timestamps | Sort-Object -Descending | Select-Object -First 1)
}

function Get-OpenPullRequests {
    <#
    .SYNOPSIS List open PRs with metadata.
    #>
    [CmdletBinding()]
    param([int]$Limit = 100)
    $prJson = Invoke-VKGithub -Args @(
        "pr", "list", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--state", "open", "--limit", $Limit.ToString(),
        "--json", "number,title,author,isDraft,createdAt,headRefName,baseRefName,mergeStateStatus,url,body"
    )
    if (-not $prJson -or $prJson -eq "[]") { return @() }
    return $prJson | ConvertFrom-Json
}

function Test-IsCopilotAuthor {
    <#
    .SYNOPSIS Determine whether a PR author is Copilot.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Author)
    $login = $Author.login
    if (-not $login) { return $false }
    return ($login -match "copilot")
}

function Get-PRDetails {
    <#
    .SYNOPSIS Get mergeability details for a PR.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $prJson = Invoke-VKGithub -Args @(
        "pr", "view", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--json", "number,state,mergeable,mergeStateStatus,isDraft,reviewDecision,url,headRefName,baseRefName,title,body"
    )
    if (-not $prJson) { return $null }
    return $prJson | ConvertFrom-Json
}

function Get-PRChecksDetail {
    <#
    .SYNOPSIS Get detailed check info for a PR.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $checksJson = Invoke-VKGithub -Args @(
        "pr", "checks", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--json", "name,state,link,startedAt,completedAt"
    )
    if (-not $checksJson) { return @() }
    return $checksJson | ConvertFrom-Json
}

function Get-RequiredChecksForBranch {
    <#
    .SYNOPSIS Get required status check names for a branch.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Branch)
    $result = Invoke-VKGithub -Args @(
        "api",
        "repos/$script:GH_OWNER/$script:GH_REPO/branches/$Branch/protection/required_status_checks"
    )
    if (-not $result) { return @() }
    $payload = $result | ConvertFrom-Json
    if (-not $payload) { return @() }

    $names = @()
    if ($payload.contexts) {
        $names += @($payload.contexts | Where-Object { $_ })
    }
    if ($payload.checks) {
        $names += @($payload.checks | ForEach-Object {
                if ($_.context) { $_.context } else { $_.name }
            } | Where-Object { $_ })
    }

    return @($names | Sort-Object -Unique)
}

function Get-PRRequiredCheckStatus {
    <#
    .SYNOPSIS Evaluate only required checks for a PR.
    .OUTPUTS "passing", "failing", "pending", or "unknown"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [Parameter(Mandatory)][string]$BaseBranch
    )
    $required = Get-RequiredChecksForBranch -Branch $BaseBranch
    if (-not $required -or @($required).Count -eq 0) {
        return "passing"
    }

    $checks = Get-PRChecksDetail -PRNumber $PRNumber
    if (-not $checks) { return "unknown" }

    $requiredLower = $required | ForEach-Object { $_.ToLowerInvariant() }
    $checksByName = @{}
    foreach ($check in $checks) {
        if (-not $check.name) { continue }
        $checksByName[$check.name.ToLowerInvariant()] = $check.state
    }

    $hasPending = $false
    foreach ($name in $requiredLower) {
        if (-not $checksByName.ContainsKey($name)) {
            $hasPending = $true
            continue
        }
        $state = $checksByName[$name]
        if ($state -in @("FAILURE", "ERROR")) { return "failing" }
        if ($state -in @("PENDING", "IN_PROGRESS", "QUEUED")) { $hasPending = $true }
    }

    if ($hasPending) { return "pending" }
    return "passing"
}

function Create-GithubIssue {
    <#
    .SYNOPSIS Create a GitHub issue.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Body
    )
    $result = Invoke-VKGithub -Args @(
        "api",
        "repos/$script:GH_OWNER/$script:GH_REPO/issues",
        "-f", "title=$Title",
        "-f", "body=$Body"
    )
    if (-not $result) { return $null }
    return $result | ConvertFrom-Json
}

function Assign-IssueToCopilot {
    <#
    .SYNOPSIS Assign a GitHub issue to Copilot.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$IssueNumber)
    $result = Invoke-VKGithub -Args @(
        "api",
        "repos/$script:GH_OWNER/$script:GH_REPO/issues/$IssueNumber/assignees",
        "-f", "assignees[]=copilot"
    )
    return ($null -ne $result)
}

function Get-RecentMergedPRs {
    <#
    .SYNOPSIS List recent merged PRs.
    #>
    [CmdletBinding()]
    param([int]$Limit = 15)
    $prJson = Invoke-VKGithub -Args @(
        "pr", "list", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--state", "merged", "--limit", $Limit.ToString(),
        "--json", "number,title,url,mergedAt"
    )
    if (-not $prJson -or $prJson -eq "[]") { return @() }
    return $prJson | ConvertFrom-Json
}

function Get-FailingWorkflowRuns {
    <#
    .SYNOPSIS Get recent failing workflow runs on main.
    #>
    [CmdletBinding()]
    param([int]$Limit = 8)
    $result = Invoke-VKGithub -Args @(
        "api",
        "repos/$script:GH_OWNER/$script:GH_REPO/actions/runs",
        "-f", "branch=main",
        "-f", "status=completed",
        "-f", "per_page=$Limit"
    )
    if (-not $result) { return @() }
    $payload = $result | ConvertFrom-Json
    $runs = $payload.workflow_runs
    if (-not $runs) { return @() }
    return $runs | Where-Object {
        $_.conclusion -in @("failure", "cancelled", "timed_out", "action_required")
    }
}

function Format-PRCheckFailures {
    <#
    .SYNOPSIS Format failing checks into a short markdown list.
    #>
    [CmdletBinding()]
    param([object[]]$Checks = @())
    if (-not $Checks -or $Checks.Count -eq 0) { return "- No failing checks found" }
    $failed = $Checks | Where-Object { $_.state -eq "FAILURE" -or $_.state -eq "ERROR" }
    if (-not $failed -or $failed.Count -eq 0) { return "- No failing checks found" }
    $lines = $failed | ForEach-Object {
        $link = if ($_.link) { " ($($_.link))" } else { "" }
        "- $($_.name): $($_.state)$link"
    }
    return ($lines -join "`n")
}

function Add-PRComment {
    <#
    .SYNOPSIS Add a comment to a PR.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [Parameter(Mandatory)][string]$Body
    )
    $result = Invoke-VKGithub -Args @(
        "pr", "comment", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--body", $Body
    )
    return ($null -ne $result)
}

function Get-PRComments {
    <#
    .SYNOPSIS Fetch recent PR comments (issue comments).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [int]$Limit = 30
    )
    $result = Invoke-VKGithub -Args @(
        "api",
        "repos/$script:GH_OWNER/$script:GH_REPO/issues/$PRNumber/comments",
        "-f", "per_page=$Limit"
    )
    if (-not $result) { return @() }
    try {
        return $result | ConvertFrom-Json
    }
    catch {
        return @()
    }
}

function Test-CopilotRateLimitComment {
    <#
    .SYNOPSIS Detect Copilot rate limit notices OR "stopped work due to error" in PR comments.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $comments = Get-PRComments -PRNumber $PRNumber -Limit 30
    if (-not $comments) { return $null }
    $pattern = "copilot stopped work|rate limit|rate-limited|secondary rate limit|due to an error"
    foreach ($comment in $comments) {
        if (-not $comment.body) { continue }
        $body = $comment.body.ToString()
        if ($body -match $pattern -and $body -match "copilot") {
            $isError = $body -match "due to an error|stopped work"
            return @{
                hit        = $true
                is_error   = [bool]$isError
                body       = $body
                created_at = $comment.created_at
                author     = $comment.user?.login
            }
        }
    }
    return $null
}

function Test-PRHasCopilotComment {
    <#
    .SYNOPSIS Check if @copilot has already been mentioned in PR comments.
              Returns $true if any comment body contains '@copilot' — meaning Copilot
              was already triggered and should NOT be triggered again.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $comments = Get-PRComments -PRNumber $PRNumber -Limit 50
    if (-not $comments) { return $false }
    foreach ($comment in $comments) {
        if (-not $comment.body) { continue }
        if ($comment.body.ToString() -match "@copilot") {
            return $true
        }
    }
    return $false
}

function Test-CopilotPRClosed {
    <#
    .SYNOPSIS Check if a Copilot-authored PR for this PR number was ever closed.
              If so, we should never trigger @copilot for this PR again.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $search = "$PRNumber in:title,body"
    $prJson = Invoke-VKGithub -Args @(
        "pr", "list", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--state", "closed", "--search", $search,
        "--json", "number,title,body,author",
        "--limit", "10"
    )
    if (-not $prJson) { return $false }
    $prs = $prJson | ConvertFrom-Json
    if (-not $prs) { return $false }
    $pattern = "(?i)(PR\s*#?$PRNumber|#$PRNumber)"
    foreach ($pr in $prs) {
        if (($pr.title -match $pattern) -or ($pr.body -match $pattern)) {
            $authorLogin = if ($pr.author -and $pr.author.login) { $pr.author.login } else { "" }
            if ($authorLogin -match "copilot|bot") {
                return $true
            }
        }
    }
    return $false
}

function Mark-PRReady {
    <#
    .SYNOPSIS Mark a PR as ready for review (exit draft).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $result = Invoke-VKGithub -Args @(
        "pr", "ready", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO"
    )
    return ($null -ne $result)
}

function Find-CopilotFixPR {
    <#
    .SYNOPSIS Find a Copilot fix PR referencing an original PR number.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$OriginalPRNumber)
    $search = "$OriginalPRNumber in:title,body"
    $prJson = Invoke-VKGithub -Args @(
        "pr", "list", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--state", "open", "--search", $search,
        "--json", "number,title,body,headRefName,baseRefName,isDraft,url,createdAt",
        "--limit", "20"
    )
    if (-not $prJson) { return $null }
    $prs = $prJson | ConvertFrom-Json
    if (-not $prs) { return $null }
    $pattern = "(?i)(PR\s*#?$OriginalPRNumber|#$OriginalPRNumber)"
    $match = $prs | Where-Object {
        ($_.title -match $pattern) -or ($_.body -match $pattern)
    } | Sort-Object -Property createdAt -Descending | Select-Object -First 1
    return $match
}

function Test-CopilotPRComplete {
    <#
    .SYNOPSIS Determine whether a Copilot PR is complete (not WIP and not draft).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$PRDetails)
    if (-not $PRDetails) { return $false }
    if ($PRDetails.isDraft) { return $false }
    if ($PRDetails.title -match "^\[WIP\]") { return $false }
    return $true
}

function Close-PRDeleteBranch {
    <#
    .SYNOPSIS Close a PR and delete its branch.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $result = Invoke-VKGithub -Args @(
        "pr", "close", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--delete-branch"
    )
    return ($null -ne $result)
}

function Merge-BranchFromPR {
    <#
    .SYNOPSIS Merge a PR head branch into a target base branch.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseBranch,
        [Parameter(Mandatory)][string]$HeadBranch
    )
    $result = Invoke-VKGithub -Args @(
        "api", "repos/$script:GH_OWNER/$script:GH_REPO/merges",
        "-f", "base=$BaseBranch",
        "-f", "head=$HeadBranch"
    )
    return ($null -ne $result)
}

function Create-PRForBranch {
    <#
    .SYNOPSIS Create a PR for a branch when the agent did not open one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Branch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Body = "Automated PR created by ve-orchestrator"
    )
    $baseBranch = $script:VK_TARGET_BRANCH
    if ($baseBranch -like "origin/*") { $baseBranch = $baseBranch.Substring(7) }
    $result = Invoke-VKGithub -Args @(
        "pr", "create", "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--head", $Branch,
        "--base", $baseBranch,
        "--title", $Title,
        "--body", $Body
    )
    return ($null -ne $result)
}

function Test-RemoteBranchExists {
    <#
    .SYNOPSIS Check if a branch exists on the remote GitHub repo.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Branch)
    $result = Invoke-VKGithub -Args @(
        "api",
        "repos/$script:GH_OWNER/$script:GH_REPO/branches/$Branch"
    )
    return ($null -ne $result)
}

function Get-VKSessions {
    <#
    .SYNOPSIS List sessions for a workspace.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$WorkspaceId)
    $result = Invoke-VKApi -Path "/api/sessions?workspace_id=$WorkspaceId"
    if (-not $result) { return @() }
    return @($result)
}

function New-VKSession {
    <#
    .SYNOPSIS Create a new session for a workspace.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$WorkspaceId)
    $body = @{ workspace_id = $WorkspaceId }
    return Invoke-VKApi -Path "/api/sessions" -Method "POST" -Body $body
}

function Get-ExecutorProfileForSession {
    <#
    .SYNOPSIS Map a session executor to an executor profile.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Executor)
    switch ($Executor) {
        "COPILOT" { return @{ executor = "COPILOT"; variant = "CLAUDE_OPUS_4_6" } }
        "CODEX" { return @{ executor = "CODEX"; variant = "DEFAULT" } }
        default { return @{ executor = "CODEX"; variant = "DEFAULT" } }
    }
}

function Send-VKWorkspaceFollowUp {
    <#
    .SYNOPSIS Send a direct follow-up message to the latest session for a workspace.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$Message,
        [hashtable]$ExecutorOverride
    )
    $sessions = Get-VKSessions -WorkspaceId $WorkspaceId
    if (-not $sessions -or @($sessions).Count -eq 0) { return $false }
    $session = $sessions | Sort-Object -Property updated_at -Descending | Select-Object -First 1
    $profile = if ($ExecutorOverride) { $ExecutorOverride } else { Get-ExecutorProfileForSession -Executor $session.executor }
    return Send-VKSessionFollowUp -SessionId $session.id -Message $Message -ExecutorProfile $profile
}

function Send-VKSessionFollowUp {
    <#
    .SYNOPSIS Send a follow-up message to a specific session.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][hashtable]$ExecutorProfile
    )
    $body = @{ prompt = $Message; executor_profile_id = $ExecutorProfile }
    $result = Invoke-VKApi -Path "/api/sessions/$SessionId/follow-up" -Method "POST" -Body $body
    return ($null -ne $result)
}

function Queue-VKWorkspaceMessage {
    <#
    .SYNOPSIS Enqueue a message to the latest session for a workspace.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$Message
    )
    $sessions = Get-VKSessions -WorkspaceId $WorkspaceId
    if (-not $sessions -or @($sessions).Count -eq 0) { return $false }
    $session = $sessions | Sort-Object -Property updated_at -Descending | Select-Object -First 1
    $profile = Get-ExecutorProfileForSession -Executor $session.executor
    $body = @{ executor_profile_id = $profile; message = $Message }
    $result = Invoke-VKApi -Path "/api/sessions/$($session.id)/queue" -Method "POST" -Body $body
    return ($null -ne $result)
}

function Merge-PR {
    <#
    .SYNOPSIS Merge a PR after rebase onto latest main. Returns $true on success.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$PRNumber,
        [switch]$AutoMerge,
        [switch]$Admin
    )
    $args = @(
        "pr", "merge", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--squash", "--delete-branch"
    )
    if ($AutoMerge) { $args += "--auto" }
    if ($Admin) { $args += "--admin" }
    if ($AutoMerge) {
        Write-Host "  Enabling auto-merge for PR #$PRNumber ..." -ForegroundColor Yellow
    }
    elseif ($Admin) {
        Write-Host "  Admin merging PR #$PRNumber ..." -ForegroundColor Yellow
    }
    else {
        Write-Host "  Merging PR #$PRNumber ..." -ForegroundColor Yellow
    }
    $result = Invoke-VKGithub -Args $args
    return ($null -ne $result)
}

function Enable-AutoMerge {
    <#
    .SYNOPSIS Enable auto-merge on a PR so it merges when CI passes.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$PRNumber)
    $result = Invoke-VKGithub -Args @(
        "pr", "merge", $PRNumber.ToString(), "--repo", "$script:GH_OWNER/$script:GH_REPO",
        "--auto", "--squash", "--delete-branch"
    )
    return ($null -ne $result)
}

# ─── Orchestration Helpers ────────────────────────────────────────────────────

function Get-ActiveAttemptCount {
    <#
    .SYNOPSIS Count non-archived attempts that have running agents.
    #>
    $attempts = Get-VKAttempts -ActiveOnly
    return @($attempts).Count
}

function Get-AttemptTaskMap {
    <#
    .SYNOPSIS Build a hashtable mapping task_id → latest attempt for active (non-archived) attempts.
    #>
    $attempts = Get-VKAttempts -ActiveOnly
    $map = @{}
    foreach ($a in $attempts) {
        $map[$a.task_id] = $a
    }
    return $map
}

function Test-AttemptComplete {
    <#
    .SYNOPSIS Check if an attempt has completed (branch pushed + PR exists or is merged).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Attempt)
    if (-not $Attempt.branch) { return $false }
    $pr = Get-PRForBranch -Branch $Attempt.branch
    return ($null -ne $pr)
}

# ─── Display Helpers ──────────────────────────────────────────────────────────

function Show-Tasks {
    [CmdletBinding()]
    param(
        [ValidateSet("todo", "inprogress", "inreview", "done", "cancelled")]
        [string]$Status = "todo"
    )
    $tasks = Get-VKTasks -Status $Status
    if (-not $tasks) {
        Write-Host "  No tasks with status '$Status'" -ForegroundColor Yellow
        return
    }
    Write-Host ""
    Write-Host "  ┌─ $($Status.ToUpper()) Tasks ($(@($tasks).Count)) ─────────────────" -ForegroundColor Cyan
    foreach ($t in $tasks) {
        $age = if ($t.created_at) { [math]::Round(((Get-Date) - [datetime]$t.created_at).TotalDays, 0) } else { "?" }
        $inProgress = if ($t.has_in_progress_attempt) { " [RUNNING]" } else { "" }
        Write-Host "  │ $($t.id.Substring(0,8))  $($t.title)$inProgress" -ForegroundColor $(if ($t.has_in_progress_attempt) { "Yellow" } else { "White" })
    }
    Write-Host "  └───────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host ""
}

function Show-Status {
    [CmdletBinding()]
    param(
        [switch]$ShowIdle
    )
    if (-not (Initialize-VKConfig)) { return }
    $active = Get-VKAttempts -ActiveOnly
    $todoTasks = Get-VKTasks -Status "todo"
    $inProgressTasks = Get-VKTasks -Status "inprogress"

    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║     VirtEngine Kanban Status              ║" -ForegroundColor Cyan
    Write-Host "  ╚═══════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Todo:        $(@($todoTasks).Count) tasks" -ForegroundColor White
    Write-Host "  In-Progress: $(@($inProgressTasks).Count) tasks" -ForegroundColor Yellow
    Write-Host "  Active Attempts: $(@($active).Count)" -ForegroundColor Green
    Write-Host ""

    if ($active -and @($active).Count -gt 0) {
        Write-Host "  ┌─ Active Attempts ──────────────────────────" -ForegroundColor Green
        foreach ($a in $active) {
            $name = if ($a.name) { $a.name.Substring(0, [Math]::Min(60, $a.name.Length)) } else { "(unnamed)" }
            $pr = Get-PRForBranch -Branch $a.branch 2>$null
            $prStatus = if ($pr) { "PR #$($pr.number) ($($pr.state))" } else { "No PR" }
            Write-Host "  │ $($a.id.Substring(0,8))  $($a.branch)" -ForegroundColor White
            Write-Host "  │   $name" -ForegroundColor DarkGray
            Write-Host "  │   $prStatus" -ForegroundColor $(if ($pr -and $pr.state -eq "MERGED") { "Green" } elseif ($pr) { "Yellow" } else { "DarkGray" })
            if ($ShowIdle) {
                $lastUpdate = if ($a.updated_at) { [datetime]$a.updated_at } elseif ($a.created_at) { [datetime]$a.created_at } else { $null }
                $idleMinutes = if ($lastUpdate) { [math]::Round(((Get-Date) - $lastUpdate).TotalMinutes, 1) } else { "?" }
                $updatedAtText = if ($lastUpdate) { $lastUpdate.ToString("u") } else { "unknown" }
                Write-Host "  │   Idle: ${idleMinutes} min (last update: $updatedAtText)" -ForegroundColor DarkGray
            }
        }
        Write-Host "  └────────────────────────────────────────────" -ForegroundColor Green
    }
    Write-Host ""
}

# ─── CLI Dispatch ─────────────────────────────────────────────────────────────

function Invoke-CLI {
    param([string[]]$Arguments)

    if ($null -eq $Arguments) {
        $Arguments = @()
    }
    else {
        $Arguments = @($Arguments)
    }

    if ($Arguments.Count -eq 0) {
        Show-Usage
        return
    }

    $command = $Arguments[0]
    $rest = if ($Arguments.Count -gt 1) { $Arguments[1..($Arguments.Count - 1)] } else { @() }

    switch ($command) {
        "create" {
            $title = $null
            $description = $null
            $descFile = $null
            $status = "todo"
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if ($rest[$i] -in @("--title", "-t") -and ($i + 1) -lt $rest.Count) { $title = $rest[$i + 1] }
                if ($rest[$i] -in @("--description", "--desc", "-d") -and ($i + 1) -lt $rest.Count) { $description = $rest[$i + 1] }
                if ($rest[$i] -in @("--description-file", "--desc-file") -and ($i + 1) -lt $rest.Count) { $descFile = $rest[$i + 1] }
                if ($rest[$i] -in @("--status", "-s") -and ($i + 1) -lt $rest.Count) { $status = $rest[$i + 1] }
            }
            if (-not $description -and $descFile) {
                try { $description = Get-Content -Path $descFile -Raw }
                catch { Write-Error "Failed to read description file: $descFile"; return }
            }
            if (-not $title -or -not $description) {
                Write-Error "Usage: ve-kanban create --title <title> --description <markdown> [--status todo]"
                return
            }
            $result = Create-VKTask -Title $title -Description $description -Status $status
            if ($result -and $result.id) {
                Write-Host "  ✓ Task created: $($result.id) — $title" -ForegroundColor Green
            }
            elseif ($result) {
                Write-Host "  ✓ Task created: $title" -ForegroundColor Green
            }
            else {
                Write-Error "Failed to create task."
            }
        }
        "list" {
            $status = "todo"
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if ($rest[$i] -in @("--status", "-s") -and ($i + 1) -lt $rest.Count) { $status = $rest[$i + 1] }
            }
            Show-Tasks -Status $status
        }
        "status" {
            $showIdle = $false
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if ($rest[$i] -in @("--verbose", "-v")) { $showIdle = $true }
            }
            if ($VerbosePreference -eq "Continue") { $showIdle = $true }
            if (Test-CLIFlagPresent -Flags @("--verbose", "-v") -Arguments $rest) { $showIdle = $true }
            Show-Status -ShowIdle:$showIdle
        }
        "archived" {
            $archived = Get-VKArchivedAttempts
            if (-not $archived -or @($archived).Count -eq 0) {
                Write-Host "  No archived attempts." -ForegroundColor Yellow
                return
            }
            Write-Host "";
            Write-Host "  ┌─ Archived Attempts ─────────────────────────" -ForegroundColor DarkGray
            foreach ($a in $archived) {
                $name = if ($a.name) { $a.name.Substring(0, [Math]::Min(60, $a.name.Length)) } else { "(unnamed)" }
                Write-Host "  │ $($a.id.Substring(0,8))  $($a.branch)" -ForegroundColor White
                Write-Host "  │   $name" -ForegroundColor DarkGray
            }
            Write-Host "  └────────────────────────────────────────────" -ForegroundColor DarkGray
            Write-Host ""
        }
        "unarchive" {
            if ($rest.Count -eq 0) { Write-Error "Usage: ve-kanban unarchive <attempt-id>"; return }
            Unarchive-VKAttempt -AttemptId $rest[0] | Out-Null
            Write-Host "  ✓ Attempt $($rest[0]) unarchived" -ForegroundColor Green
        }
        "submit" {
            if ($rest.Count -eq 0) { Write-Error "Usage: ve-kanban submit <task-id>"; return }
            $taskId = $rest[0]
            Submit-VKTaskAttempt -TaskId $taskId
        }
        "submit-next" {
            $count = 1
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if ($rest[$i] -in @("--count", "-n") -and ($i + 1) -lt $rest.Count) { $count = [int]$rest[$i + 1] }
            }
            $tasks = Get-VKNextTodoTasks -Count $count
            if (-not $tasks -or @($tasks).Count -eq 0) {
                Write-Host "  No todo tasks available." -ForegroundColor Yellow
                return
            }
            foreach ($t in $tasks) {
                Write-Host "  → $($t.title)" -ForegroundColor White
                Submit-VKTaskAttempt -TaskId $t.id
            }
        }
        "rebase" {
            if ($rest.Count -eq 0) { Write-Error "Usage: ve-kanban rebase <attempt-id>"; return }
            Invoke-VKRebase -AttemptId $rest[0]
        }
        "merge" {
            $branch = $null
            $auto = $false
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if ($rest[$i] -in @("--branch", "-b") -and ($i + 1) -lt $rest.Count) { $branch = $rest[$i + 1] }
                if ($rest[$i] -eq "--auto") { $auto = $true }
            }
            if (-not $branch -and $rest.Count -gt 0 -and $rest[0] -notlike "--*") { $branch = $rest[0] }
            if (-not $branch) { Write-Error "Usage: ve-kanban merge <branch> [--auto]"; return }
            $pr = Get-PRForBranch -Branch $branch
            if (-not $pr) { Write-Error "No PR found for branch $branch"; return }
            if ($auto) {
                Enable-AutoMerge -PRNumber $pr.number
            }
            else {
                Merge-PR -PRNumber $pr.number
            }
        }
        "complete" {
            if ($rest.Count -eq 0) { Write-Error "Usage: ve-kanban complete <task-id>"; return }
            Update-VKTaskStatus -TaskId $rest[0] -Status "done"
            Write-Host "  ✓ Task $($rest[0]) marked as done" -ForegroundColor Green
        }
        "orchestrate" {
            $parallel = 2
            $interval = 60
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if ($rest[$i] -in @("--parallel", "-p") -and ($i + 1) -lt $rest.Count) { $parallel = [int]$rest[$i + 1] }
                if ($rest[$i] -in @("--interval", "-i") -and ($i + 1) -lt $rest.Count) { $interval = [int]$rest[$i + 1] }
            }
            Write-Host "  Delegating to ve-orchestrator.ps1 with parallel=$parallel, interval=$interval" -ForegroundColor Cyan
            & "$PSScriptRoot/ve-orchestrator.ps1" -MaxParallel $parallel -PollIntervalSec $interval
        }
        "help" { Show-Usage }
        default {
            Write-Error "Unknown command: $command"
            Show-Usage
        }
    }
}

function Show-Usage {
    Write-Host @"

  VirtEngine Kanban CLI (ve-kanban)
  ═════════════════════════════════

  COMMANDS:
    create --title <title> --description <md> [--status todo]
                                  Create a new task
    list [--status <status>]        List tasks (default: todo)
    status                          Show dashboard (active attempts + queues)
    status --verbose | -v            Show dashboard with idle minutes
    archived                        List archived attempts
    unarchive <attempt-id>          Unarchive an attempt
    submit <task-id>                Submit a single task as an attempt
    submit-next [--count N]         Submit next N todo tasks as attempts
    rebase <attempt-id>             Rebase an attempt branch onto latest main
    merge <branch> [--auto]         Merge PR for a branch (--auto enables auto-merge)
    complete <task-id>              Mark a task as done
    orchestrate [--parallel N]      Run orchestration loop (default: 2 parallel)
    help                            Show this help

  ENVIRONMENT:
    VK_BASE_URL       Vibe-kanban API (default: http://127.0.0.1:54089)
    VK_PROJECT_NAME   Project name to auto-detect (default: virtengine)
    VK_PROJECT_ID     Project UUID (auto-detected if empty)
    VK_REPO_ID        Repository UUID (auto-detected if empty)
    GH_OWNER          GitHub owner (default: virtengine-gh)
    GH_REPO           GitHub repo (default: virtengine)

  EXECUTOR CYCLING:
    Alternates between CODEX/DEFAULT and COPILOT/CLAUDE_OPUS_4_6
    at 50/50 rate to avoid rate-limiting on either agent.
"@ -ForegroundColor White
}

function Test-CLIFlagPresent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Flags,
        [string[]]$Arguments
    )
    if ($Arguments) {
        foreach ($flag in $Flags) {
            if ($Arguments -contains $flag) { return $true }
        }
    }
    if ($script:VK_CLI_RAW_LINE) {
        foreach ($flag in $Flags) {
            $pattern = "(^|\s)" + [regex]::Escape($flag) + "(\s|$)"
            if ($script:VK_CLI_RAW_LINE -match $pattern) { return $true }
        }
    }
    return $false
}

# Run CLI if invoked directly (not dot-sourced)
if ($MyInvocation.InvocationName -ne ".") {
    $script:VK_CLI_RAW_LINE = $MyInvocation.Line
    Invoke-CLI -Arguments $args
}
