# Agent Work Logging - Quick Start Guide

## What This System Does

Captures **all agent work** into structured logs and enables:
- ✅ Real-time error loop detection
- ✅ Stuck agent detection
- ✅ Cost anomaly alerts
- ✅ Offline analytics for task planning improvements
- ✅ Executor performance comparison
- ✅ Common error clustering

## Architecture Quick View

```
VK Agent → ve-orchestrator.ps1 → agent-work-logger.ps1 → .cache/agent-work-logs/*.jsonl
                                                                      ↓
                                            agent-work-analyzer.mjs (live analysis)
                                                                      ↓
                                            monitor.mjs (consume alerts, trigger actions)
```

## Installation (5 Minutes)

### Step 1: Enable Logging in ve-orchestrator.ps1

Add to the **top of ve-orchestrator.ps1** (after param block, before main logic):

```powershell
# Import agent work logger
$AgentLoggerPath = Join-Path $PSScriptRoot "lib\agent-work-logger.ps1"
if (Test-Path $AgentLoggerPath) {
    Import-Module $AgentLoggerPath -Force -Global
    Write-Host "[ve-orchestrator] Agent work logger loaded" -ForegroundColor Green
} else {
    Write-Warning "[ve-orchestrator] Agent work logger not found at $AgentLoggerPath"
}
```

### Step 2: Integrate Logging Calls

#### In `Submit-VKTaskAttempt()` - After attempt creation (~line 2735)

```powershell
# After: $attempt = New-VKAttempt ...

# Log session start
Start-AgentSession -AttemptId $attempt.workspace_id `
    -TaskMetadata @{
        task_id = $task.id
        task_title = $task.title
        task_description = $task.description
        project_id = $task.project_id
    } `
    -ExecutorInfo @{
        executor = $executor
        executor_variant = $executorVariant
        model = if ($executor -eq 'CODEX') { 'claude-sonnet-4-5' } else { 'copilot-4o' }
    } `
    -GitContext @{
        branch = $attempt.branch
        base_branch = $baseRef
        commits_ahead = 0
        commits_behind = 0
    } `
    -Prompt $taskPrompt `
    -PromptType "initial"
```

#### In `Send-VKSessionFollowUp()` - After followup sent (~line 2510)

```powershell
# After: Send-VKSessionFollowUp ...

# Log followup
Write-AgentFollowup -AttemptId $attemptId `
    -Message $message `
    -Reason $reason
```

#### In `Sync-TrackedAttempts()` - When error detected (~line 3020)

```powershell
# When detecting error from summary text:
if ($errorFound) {
    Write-AgentError -AttemptId $attemptId `
        -ErrorMessage $errorText `
        -ErrorFingerprint $fingerprint `
        -ErrorCategory (Get-AttemptFailureCategory -Summary $summary)
}
```

#### In `Archive-Attempt()` - When archiving (~line 2670)

```powershell
# After archiving logic:

# Log session end
Stop-AgentSession -AttemptId $attemptId `
    -CompletionStatus $(if ($finalStatus -eq 'done') { 'success' } else { 'failed' }) `
    -Outcome @{
        status = $finalStatus
        pr_created = $attempt.pr_number -ne $null
        pr_number = $attempt.pr_number
    }
```

### Step 3: Start the Analyzer in monitor.mjs

Add to **monitor.mjs** (after imports, in main initialization):

```javascript
import { startAnalyzer } from './agent-work-analyzer.mjs';

// Start agent work analyzer (in background)
if (process.env.AGENT_WORK_ANALYZER_ENABLED !== 'false') {
  void startAnalyzer();
  console.log('[monitor] Agent work analyzer started');
}
```

### Step 4: Consume Alerts in monitor.mjs

Add alert polling loop:

```javascript
// Poll for agent work alerts
const ALERTS_LOG = resolve(repoRoot, '.cache/agent-work-logs/agent-alerts.jsonl');
let alertsPosition = 0;

setInterval(async () => {
  if (!existsSync(ALERTS_LOG)) return;

  const stats = await stat(ALERTS_LOG);
  if (stats.size <= alertsPosition) return;

  // Read new alerts
  const stream = createReadStream(ALERTS_LOG, {
    start: alertsPosition,
    encoding: 'utf8'
  });

  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    alertsPosition += Buffer.byteLength(line, 'utf8') + 1;

    try {
      const alert = JSON.parse(line);
      await handleAgentAlert(alert);
    } catch (err) {
      console.error(`[monitor] Failed to parse alert: ${err.message}`);
    }
  }
}, 5000); // Poll every 5s

async function handleAgentAlert(alert) {
  console.error(`[monitor] 🚨 Alert: ${alert.type} - ${alert.attempt_id}`);

  // Send Telegram notification
  const emoji = alert.severity === 'high' ? '❌' : alert.severity === 'medium' ? '⚠️' : 'ℹ️';
  await notify(
    `${emoji} ${alert.type.replace(/_/g, ' ').toUpperCase()}\n` +
    `Attempt: ${alert.attempt_id}\n` +
    `Executor: ${alert.executor}\n` +
    `Recommendation: ${alert.recommendation}`,
    {
      priority: alert.severity === 'high' ? 2 : alert.severity === 'medium' ? 3 : 4,
      category: 'agent_health'
    }
  );

  // Take action based on alert type
  switch (alert.type) {
    case 'error_loop':
      if (alert.recommendation === 'trigger_ai_autofix') {
        console.log(`[monitor] Triggering AI autofix for ${alert.attempt_id}`);
        // Trigger existing autofix flow
        await initiateAutoFix(alert.attempt_id, alert.error_fingerprint);
      }
      break;

    case 'tool_loop':
      if (alert.recommendation === 'fresh_session') {
        console.log(`[monitor] Requesting fresh session for ${alert.attempt_id}`);
        // Trigger fresh session via orchestrator
        await requestFreshSession(alert.attempt_id, 'tool_loop_detected');
      }
      break;

    case 'stuck_agent':
      console.log(`[monitor] Agent stuck: ${alert.attempt_id}, idle for ${Math.round(alert.idle_time_ms / 60000)} min`);
      // Could trigger health check or fresh session
      break;

    case 'cost_anomaly':
      console.log(`[monitor] Cost anomaly: ${alert.attempt_id} cost $${alert.cost_usd}`);
      // Log for review
      break;
  }
}
```

### Step 5: Add Environment Variables

Add to `.env`:

```bash
# Agent Work Logging
AGENT_WORK_LOGGING_ENABLED=true
AGENT_WORK_ANALYZER_ENABLED=true

# Detection thresholds
AGENT_ERROR_LOOP_THRESHOLD=4         # Alert after 4 repeated errors
AGENT_TOOL_LOOP_THRESHOLD=10         # Alert after 10 rapid tool calls
AGENT_STUCK_THRESHOLD_MS=300000      # 5 minutes idle = stuck
AGENT_COST_ANOMALY_THRESHOLD=1.0     # Alert if session costs >$1
```

## Usage

### View Live Agent Work Summary

```powershell
# From PowerShell
Import-Module scripts/openfleet/lib/agent-work-logger.ps1
Show-AgentWorkSummary -LastNDays 7
```

**Output:**
```
=== Agent Work Summary (Last 7 Days) ===

Overall Metrics:
  Total Sessions: 45
  Success Rate: 82.2%
  Avg Duration: 123.4s
  Total Cost: $2.34
  Total Errors: 12

By Executor:
  CODEX: 30 sessions, 86.7% success
  COPILOT: 15 sessions, 73.3% success

Top Errors:
  git_push_failed: 5 occurrences
    Sample: fatal: remote error: access denied or repository not exported...
  npm_install_timeout: 3 occurrences
    Sample: npm ERR! network timeout at: https://registry.npmjs.org/...
```

### Get Error Clusters

```powershell
Get-ErrorClusters -LastNDays 7 -TopN 10
```

### Get Session Metrics

```powershell
$metrics = Get-SessionMetrics -LastNDays 30
$metrics | Export-Csv agent-metrics.csv -NoTypeInformation
```

## Log Files

All logs stored in `.cache/agent-work-logs/`:

```
.cache/agent-work-logs/
├── agent-work-stream.jsonl       ← Main event stream (all events)
├── agent-errors.jsonl            ← Errors only (fast scanning)
├── agent-metrics.jsonl           ← Session metrics (aggregated)
├── agent-alerts.jsonl            ← Real-time alerts from analyzer
└── agent-sessions/               ← Individual session transcripts
    ├── ve-a1b2-task-slug.jsonl
    └── ve-c3d4-other-task.jsonl
```

### Example Log Entry (agent-work-stream.jsonl)

```json
{
  "timestamp": "2026-02-09T14:23:45.123Z",
  "attempt_id": "ve-a1b2-implement-auth",
  "event_type": "error",
  "task_id": "task-uuid-123",
  "task_title": "Implement user authentication",
  "executor": "CODEX",
  "model": "claude-sonnet-4-5",
  "branch": "ve/a1b2-implement-auth",
  "data": {
    "error_message": "fatal: not a git repository",
    "error_fingerprint": "git_not_repo",
    "error_category": "git"
  },
  "elapsed_ms": 12340
}
```

## Offline Analytics

### Analyze Failed Tasks

```bash
node scripts/openfleet/analyze-agent-work.mjs --task-planning --failed-only
```

**Output:**
```
=== Task: Implement OAuth integration ===
Status: manual_review | Attempts: 3

Root Cause Categories:
  dependency: 2
  api_key: 1

💡 Planning Improvements:
  - Missing dependency setup in task description
  - Missing environment setup instructions
```

### Compare Executors

```bash
node scripts/openfleet/analyze-agent-work.mjs --executor-comparison CODEX COPILOT
```

**Output:**
```
=== Executor Comparison ===

┌─────────┬────────────────┬──────────────┬─────────────────┬──────────────┐
│ Executor│ Total Sessions │ Success Rate │ Avg Duration(s) │ Avg Cost($)  │
├─────────┼────────────────┼──────────────┼─────────────────┼──────────────┤
│ CODEX   │ 120            │ 85.0%        │ 145.2           │ 0.052        │
│ COPILOT │ 60             │ 76.7%        │ 98.3            │ 0.031        │
└─────────┴────────────────┴──────────────┴─────────────────┴──────────────┘
```

### Cluster Errors

```bash
node scripts/openfleet/analyze-agent-work.mjs --error-clustering --days 30
```

**Output:**
```
=== Error Clustering Analysis ===

git_push_failed: 23 occurrences across 15 tasks
  Sample: fatal: remote error: access denied or repository not exported: /virtengine.git
  First: 2026-01-10T08:15:22Z, Last: 2026-02-08T19:42:11Z

context_window_exceeded: 12 occurrences across 8 tasks
  Sample: Error: This model's maximum context length is 200000 tokens. However, your messages...
  First: 2026-01-15T14:22:33Z, Last: 2026-02-09T11:03:45Z
```

## Real-Time Alerts

Once running, you'll get Telegram alerts like:

```
⚠️ ERROR LOOP DETECTED
Attempt: ve-a1b2-implement-auth
Executor: CODEX
Error: git_push_failed (4 occurrences in 10 min)
Recommendation: trigger_ai_autofix
```

```
ℹ️ COST ANOMALY
Attempt: ve-c3d4-complex-refactor
Executor: CODEX
Cost: $1.23 (threshold: $1.00)
Duration: 8.5 minutes
Recommendation: review_prompt_efficiency
```

## Maintenance

### Rotate Logs (Run Weekly)

```bash
# Rotate and compress old logs
bash scripts/openfleet/rotate-agent-logs.sh
```

### Clean Up Old Sessions

```bash
# Keep only last 100 sessions
ls -t .cache/agent-work-logs/agent-sessions/*.jsonl | tail -n +101 | xargs rm -f
```

## Next Steps

### Phase 1 (Week 1) - Data Capture ✅
- [x] Basic logging module
- [x] Integration points in orchestrator
- [x] Log file structure

### Phase 2 (Week 2) - Live Analysis ✅
- [x] Stream analyzer
- [x] Pattern detection (error loops, tool loops)
- [x] Alert system
- [x] Monitor integration

### Phase 3 (Week 3-4) - Offline Analytics
- [ ] Analytics CLI tool (analyze-agent-work.mjs)
- [ ] Backlog analysis
- [ ] Executor comparison
- [ ] Error clustering
- [ ] Weekly reports
- [ ] Task planning insights

### Future Enhancements
- [ ] VK API integration (capture actual agent console output)
- [ ] Session replay tool (visualize agent decisions)
- [ ] ML-based anomaly detection
- [ ] Predictive failure alerts (detect likely failures early)
- [ ] Cost optimization recommendations
- [ ] A/B testing different prompts

## Troubleshooting

### Logs not appearing?

Check if logging is enabled:
```powershell
Test-Path "scripts\openfleet\lib\agent-work-logger.ps1"
# Should return True
```

### Analyzer not running?

Check monitor.mjs console for:
```
[monitor] Agent work analyzer started
```

If not, check `.env`:
```bash
AGENT_WORK_ANALYZER_ENABLED=true
```

### Alerts not showing?

Verify alerts file exists and has data:
```powershell
Get-Content .cache/agent-work-logs/agent-alerts.jsonl | Select-Object -Last 5
```

Check alert polling is running in monitor.mjs (should see log lines every 5s when alerts occur).

---

**Ready to start?** Just follow steps 1-5 above and restart openfleet!
