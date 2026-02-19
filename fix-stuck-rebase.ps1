#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Emergency fix for stuck agent in massive rebase loop
.DESCRIPTION
    Aborts rebase, uses merge instead, squashes commits if needed
.PARAMETER WorkspacePath
    Path to the stuck workspace
.PARAMETER Branch
    Branch name being rebased
.PARAMETER BaseBranch
    Base branch to merge from (default: main)
.PARAMETER Squash
    Squash all commits into one logical commit
#>
param(
    [Parameter(Mandatory)]
    [string]$WorkspacePath,

    [Parameter(Mandatory)]
    [string]$Branch,

    [string]$BaseBranch = "main",

    [switch]$Squash
)

$ErrorActionPreference = "Stop"

Write-Host "🚨 Emergency stuck agent fix" -ForegroundColor Red
Write-Host "Workspace: $WorkspacePath" -ForegroundColor Yellow
Write-Host "Branch: $Branch" -ForegroundColor Yellow

# Check if workspace exists
if (!(Test-Path $WorkspacePath)) {
    Write-Error "Workspace not found: $WorkspacePath"
    exit 1
}

Push-Location $WorkspacePath
try {
    # Check git status
    Write-Host "`n📊 Current state:" -ForegroundColor Cyan
    $status = git status --short
    Write-Host $status

    # Check if rebase in progress
    $rebaseStatus = git status | Select-String "rebase in progress"
    if ($rebaseStatus) {
        Write-Host "`n⚠️  Rebase in progress detected" -ForegroundColor Yellow

        # Get rebase stats
        $rebaseMergeDir = ".git/rebase-merge"
        if (Test-Path $rebaseMergeDir) {
            $done = (Get-Content "$rebaseMergeDir/done" -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
            $todo = (Get-Content "$rebaseMergeDir/git-rebase-todo" -ErrorAction SilentlyContinue | Where-Object { $_ -match "^pick " } | Measure-Object -Line).Lines
            $total = $done + $todo
            Write-Host "  Progress: $done / $total commits" -ForegroundColor Yellow

            if ($total -gt 20) {
                Write-Host "  🔴 MASSIVE REBASE ($total commits) - this is inefficient!" -ForegroundColor Red
            }
        }

        # Abort the rebase
        Write-Host "`n🛑 Aborting rebase..." -ForegroundColor Red
        git rebase --abort
        Write-Host "  ✅ Rebase aborted" -ForegroundColor Green
    }

    # Check commits ahead/behind
    Write-Host "`n📈 Branch divergence:" -ForegroundColor Cyan
    git fetch origin $BaseBranch --quiet
    $ahead = git rev-list --count "origin/$BaseBranch..HEAD"
    $behind = git rev-list --count "HEAD..origin/$BaseBranch"
    Write-Host "  Commits ahead: $ahead" -ForegroundColor $(if ($ahead -gt 50) { "Red" } else { "Yellow" })
    Write-Host "  Commits behind: $behind" -ForegroundColor $(if ($behind -gt 20) { "Red" } else { "Yellow" })

    if ($behind -gt 20) {
        Write-Host "`n🔀 Using MERGE strategy (>20 commits behind)" -ForegroundColor Cyan
        Write-Host "  (Merge is faster and more reliable for large drifts)" -ForegroundColor Gray

        # Merge instead of rebase
        Write-Host "`n🔀 Merging origin/$BaseBranch..." -ForegroundColor Cyan
        $mergeOut = git merge "origin/$BaseBranch" --no-edit 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ Merge successful" -ForegroundColor Green
        }
        else {
            Write-Host "  ⚠️  Merge conflicts detected" -ForegroundColor Yellow
            Write-Host $mergeOut
            Write-Host "`n  Run 'git status' to see conflicts" -ForegroundColor Yellow
            Write-Host "  After resolving: git commit && git push" -ForegroundColor Yellow
            exit 0
        }
    }
    elseif ($behind -gt 0) {
        Write-Host "`n🔄 Using REBASE strategy (<20 commits behind)" -ForegroundColor Cyan
        git rebase "origin/$BaseBranch"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ⚠️  Rebase conflicts - aborting and using merge instead" -ForegroundColor Yellow
            git rebase --abort
            git merge "origin/$BaseBranch" --no-edit
        }
    }

    # Squash commits if requested and many commits ahead
    if ($Squash -or $ahead -gt 30) {
        Write-Host "`n📦 Squashing $ahead commits..." -ForegroundColor Cyan

        # Get first line of original commit message for reference
        $firstCommit = git log -1 --format="%s" "origin/$BaseBranch"

        # Analyze commit messages to create good squash message
        $messages = git log --format="%s" "origin/$BaseBranch..HEAD" | Group-Object
        $topMessage = ($messages | Sort-Object Count -Descending | Select-Object -First 1).Name

        Write-Host "  Most common commit prefix: $topMessage" -ForegroundColor Gray

        # Extract conventional commit prefix (e.g., "docs:", "feat:")
        $prefix = "chore"
        if ($topMessage -match "^(\w+)(\(\w+\))?:") {
            $prefix = $Matches[1]
        }

        # Create squash message
        $squashMsg = "${prefix}: " + (Read-Host -Prompt "Enter summary for squashed commits")

        # Squash all commits
        git reset --soft "origin/$BaseBranch"
        git commit -m $squashMsg

        Write-Host "  ✅ Squashed $ahead commits into 1" -ForegroundColor Green
        $ahead = 1
    }

    # Push changes
    Write-Host "`n🚀 Pushing to origin/$Branch..." -ForegroundColor Cyan
    $pushOut = git push origin "HEAD:$Branch" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ Push successful" -ForegroundColor Green
    }
    else {
        Write-Host "  ⚠️  Push failed, trying force-with-lease..." -ForegroundColor Yellow
        $pushOut = git push origin "HEAD:$Branch" --force-with-lease 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ Force push successful" -ForegroundColor Green
        }
        else {
            Write-Host "  ❌ Push failed:" -ForegroundColor Red
            Write-Host $pushOut
            exit 1
        }
    }

    Write-Host "`n✅ Stuck agent fixed!" -ForegroundColor Green
    Write-Host "  Branch: $Branch" -ForegroundColor Gray
    Write-Host "  Commits ahead: $ahead" -ForegroundColor Gray
    Write-Host "  Strategy: $(if ($behind -gt 20) { "MERGE" } else { "REBASE" })" -ForegroundColor Gray

}
finally {
    Pop-Location
}
