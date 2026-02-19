# Agent Work Logging & Analysis System Design

## Executive Summary

Design a comprehensive logging system to capture ALL agent work, enable real-time error detection, and support deep analytics for improving task planning, prompts, and executor strategies.

## Current State (Gaps Identified)

The system currently tracks:
- ✓ Attempt metadata (status, executor, timestamps)
- ✓ Error fingerprints & retry counts
- ✓ PR creation & merge status
- ✓ Follow-up messages sent

**Critical Missing Data:**
- ✗ Actual agent console output/logs
- ✗ Session conversation history (agent responses, thinking)
- ✗ Detailed error messages & stack traces
- ✗ Real-time progress updates
- ✗ File changes analysis
- ✗ Time-series performance data

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    VK Agent Workspace                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Agent Session (Codex/Copilot/etc.)                      │   │
│  │  - Console output                                        │   │
│  │  - Conversation transcript                               │   │
│  │  - Tool calls & results                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ↓                                      │
│                 (Stream via stdio/logs)                          │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│              Agent Work Stream Collector                        │
│  - Capture stdout/stderr from agent process                     │
│  - Parse conversation JSON (if available)                       │
│  - Extract tool calls, errors, decisions                        │
│  - Enrich with metadata (task, executor, timestamps)            │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│         Centralized Log Storage (.cache/agent-work-logs/)       │
│                                                                 │
│  agent-work-stream.jsonl      ← Live append-only log           │
│  agent-sessions/              ← Individual session transcripts  │
│    └─ {attempt-id}.jsonl                                        │
│  agent-errors.jsonl           ← Extracted errors only           │
│  agent-metrics.jsonl          ← Aggregated performance data     │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                  Live Stream Analyzer                           │
│  - Tail agent-work-stream.jsonl in real-time                   │
│  - Pattern matching for known errors                            │
│  - Anomaly detection (stuck agents, loops)                      │
│  - Emit alerts to openfleet                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│            openfleet Integration                            │
│  - Consume real-time alerts from analyzer                       │
│  - Trigger interventions (fresh session, AI autofix)            │
│  - Send Telegram notifications for critical patterns            │
└─────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│              Offline Analytics Engine                           │
│  - Backlog analysis: task success patterns                      │
│  - Task planning analysis: prompt effectiveness                 │
│  - Executor comparison: model success rates                     │
│  - Error clustering: common failure modes                       │
│  - Time-series metrics: throughput, latency                     │
└─────────────────────────────────────────────────────────────────┘
```

## Log Format Specification

### 1. Agent Work Stream Log (`agent-work-stream.jsonl`)

**Format:** JSON Lines (JSONL) - one JSON object per line, newline-delimited

**Schema:**
```jsonc
{
  // Core identifiers
  "timestamp": "2026-02-09T14:23:45.123Z",
  "attempt_id": "ve-a1b2c3-task-slug",
  "session_id": "session-uuid",
  "task_id": "task-uuid",

  // Task metadata
  "task_title": "Implement user authentication",
  "task_description": "Add JWT-based auth...",
  "project_id": "project-uuid",

  // Executor metadata
  "executor": "CODEX",
  "executor_variant": "claude-sonnet-4-5",
  "model": "claude-sonnet-4-5-20250929",

  // Event data
  "event_type": "agent_output" | "agent_thinking" | "tool_call" | "tool_result" | "error" | "session_start" | "session_end" | "followup_sent",

  // Event-specific payloads
  "data": {
    // For agent_output:
    "output": "string content",
    "stream_type": "stdout" | "stderr",

    // For agent_thinking:
    "thinking": "internal reasoning...",

    // For tool_call:
    "tool_name": "Edit",
    "tool_params": { "file_path": "...", ... },

    // For tool_result:
    "tool_name": "Edit",
    "result": "success | error",
    "result_data": "...",

    // For error:
    "error_message": "fatal: not a git repository",
    "error_fingerprint": "git_not_repo",
    "error_category": "git",
    "stack_trace": "...",

    // For session_start:
    "prompt": "Initial task prompt or followup message",
    "prompt_type": "initial" | "followup" | "retry",
    "followup_reason": "error_recovery" | "push_request" | "manual_review",

    // For session_end:
    "completion_status": "success" | "failed" | "timeout" | "interrupted",
    "duration_ms": 45000,
    "total_tokens": 12500,
    "cost_usd": 0.025
  },

  // Git context
  "branch": "ve/a1b2-implement-auth",
  "base_branch": "main",
  "commits_ahead": 3,
  "commits_behind": 0,

  // Performance metadata
  "elapsed_ms": 1234,  // Time since session start
  "sequence_num": 42,  // Event sequence number in session

  // Annotations (for offline analysis)
  "tags": ["error_loop", "context_exhaustion"],
  "manual_notes": "Agent got stuck on import error"
}
```

### 2. Session Transcript Log (`agent-sessions/{attempt-id}.jsonl`)

**Purpose:** Complete session history for deep analysis and replay

**Format:** Same as agent-work-stream.jsonl but filtered to single session

**Retention:** Keep last 100 sessions (configurable)

### 3. Error-Only Log (`agent-errors.jsonl`)

**Purpose:** Fast error scanning without noise

**Format:** Subset of agent-work-stream.jsonl where `event_type = "error"`

**Indexing:** Include error_fingerprint, error_category for quick filtering

### 4. Metrics Log (`agent-metrics.jsonl`)

**Purpose:** Aggregated performance metrics per session

**Schema:**
```jsonc
{
  "timestamp": "2026-02-09T14:30:00.000Z",
  "attempt_id": "ve-a1b2c3-task-slug",
  "task_id": "task-uuid",
  "executor": "CODEX",
  "model": "claude-sonnet-4-5",

  "metrics": {
    "duration_ms": 180000,
    "total_tokens": 25000,
    "cost_usd": 0.050,
    "tool_calls": 23,
    "errors": 2,
    "files_modified": 5,
    "lines_added": 120,
    "lines_deleted": 45,
    "commits": 3,
    "success": true,
    "first_shot_success": false,
    "retry_count": 1
  },

  "outcome": {
    "status": "completed" | "failed" | "manual_review",
    "pr_created": true,
    "pr_number": 601,
    "pr_merged": false,
    "test_passed": true,
    "build_passed": true
  },

  "error_summary": {
    "total_errors": 2,
    "error_categories": ["git", "dependency"],
    "error_fingerprints": ["git_push_failed", "npm_install_timeout"],
    "resolved_by_agent": 1,
    "resolved_by_intervention": 1
  }
}
```

## Implementation Plan

### Phase 1: Data Capture (Week 1)

**Goal:** Start capturing agent output streams

#### 1.1 VK Session Output Capture

**Option A: VK API Enhancement (Preferred)**
- Add endpoint: `GET /api/sessions/{session_id}/stream` - Server-sent events for live output
- Add endpoint: `GET /api/sessions/{session_id}/transcript` - Full conversation history
- Modify VK to persist session logs alongside workspace state

**Option B: Process Wrapper (Fallback)**
- Wrap VK agent process launch with stdout/stderr capture
- Stream output to `.cache/agent-work-logs/agent-work-stream.jsonl`
- Parse structured output if available (JSON mode)

**Implementation in ve-orchestrator.ps1:**
```powershell
function Start-AgentWorkLogger {
    param($AttemptId, $SessionId, $Executor, $TaskMetadata)

    # Create log entry for session start
    $logEntry = @{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        attempt_id = $AttemptId
        session_id = $SessionId
        task_id = $TaskMetadata.id
        task_title = $TaskMetadata.title
        executor = $Executor
        event_type = "session_start"
        data = @{ prompt_type = "initial" }
    } | ConvertTo-Json -Compress

    Add-Content -Path ".cache/agent-work-logs/agent-work-stream.jsonl" -Value $logEntry
}

function Write-AgentWorkLog {
    param($AttemptId, $EventType, $Data)

    $logEntry = @{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        attempt_id = $AttemptId
        event_type = $EventType
        data = $Data
        elapsed_ms = ((Get-Date) - $script:SessionStartTimes[$AttemptId]).TotalMilliseconds
    } | ConvertTo-Json -Compress -Depth 10

    # Append to main stream
    Add-Content -Path ".cache/agent-work-logs/agent-work-stream.jsonl" -Value $logEntry

    # Append to session-specific log
    $sessionLogPath = ".cache/agent-work-logs/agent-sessions/$AttemptId.jsonl"
    Add-Content -Path $sessionLogPath -Value $logEntry
}
```

#### 1.2 Integration Points

**In `Submit-VKTaskAttempt()` (ve-kanban.ps1:450):**
```powershell
# After session creation, start logger
Start-AgentWorkLogger -AttemptId $attemptId -SessionId $sessionId `
    -Executor $executor -TaskMetadata $task
```

**In `Send-VKSessionFollowUp()` (ve-kanban.ps1:580):**
```powershell
# Log followup message
Write-AgentWorkLog -AttemptId $attemptId -EventType "followup_sent" `
    -Data @{ prompt = $message; followup_reason = $reason }
```

**In `Sync-TrackedAttempts()` (ve-orchestrator.ps1:2950):**
```powershell
# When detecting errors from summaries
Write-AgentWorkLog -AttemptId $attemptId -EventType "error" `
    -Data @{ error_message = $errorText; error_fingerprint = $fingerprint }
```

### Phase 2: Live Stream Analyzer (Week 2)

**Goal:** Real-time error detection and intervention

#### 2.1 Log Tailing Service

**New file:** `scripts/openfleet/agent-work-analyzer.mjs`

```javascript
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { watch } from 'fs/promises';

const AGENT_WORK_STREAM = '.cache/agent-work-logs/agent-work-stream.jsonl';

// In-memory session state for pattern detection
const activeSessions = new Map(); // sessionId -> { errors: [], lastEvent: timestamp }

async function tailAgentWorkStream() {
  let filePosition = 0;

  // Initial read
  filePosition = await processLogFile(filePosition);

  // Watch for changes
  const watcher = watch(AGENT_WORK_STREAM);
  for await (const event of watcher) {
    if (event.eventType === 'change') {
      filePosition = await processLogFile(filePosition);
    }
  }
}

async function processLogFile(startPosition) {
  const stream = createReadStream(AGENT_WORK_STREAM, {
    start: startPosition,
    encoding: 'utf8'
  });

  const rl = createInterface({ input: stream });
  let bytesRead = startPosition;

  for await (const line of rl) {
    bytesRead += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline

    try {
      const event = JSON.parse(line);
      await analyzeEvent(event);
    } catch (err) {
      console.error(`[agent-work-analyzer] failed to parse log line: ${err.message}`);
    }
  }

  return bytesRead;
}

async function analyzeEvent(event) {
  const { attempt_id, session_id, event_type, data, timestamp } = event;

  // Track session state
  if (!activeSessions.has(session_id)) {
    activeSessions.set(session_id, {
      attempt_id,
      errors: [],
      lastEvent: timestamp,
      startedAt: timestamp
    });
  }

  const session = activeSessions.get(session_id);
  session.lastEvent = timestamp;

  // Pattern detection
  switch (event_type) {
    case 'error':
      await handleError(session, event);
      break;
    case 'tool_call':
      await detectSuspiciousToolUse(session, event);
      break;
    case 'session_end':
      await finalizeSession(session, event);
      activeSessions.delete(session_id);
      break;
  }
}

async function handleError(session, event) {
  const { error_fingerprint, error_message } = event.data;

  session.errors.push({
    fingerprint: error_fingerprint,
    message: error_message,
    timestamp: event.timestamp
  });

  // Error loop detection (similar to monitor.mjs)
  const recentErrors = session.errors.filter(e =>
    Date.now() - new Date(e.timestamp).getTime() < 10 * 60 * 1000 // 10 min window
  );

  const errorCounts = {};
  for (const err of recentErrors) {
    errorCounts[err.fingerprint] = (errorCounts[err.fingerprint] || 0) + 1;
  }

  // Alert if same error 4+ times
  for (const [fingerprint, count] of Object.entries(errorCounts)) {
    if (count >= 4) {
      await emitAlert({
        type: 'error_loop',
        attempt_id: session.attempt_id,
        error_fingerprint: fingerprint,
        occurrences: count,
        recommendation: 'trigger_ai_autofix'
      });
    }
  }
}

async function detectSuspiciousToolUse(session, event) {
  const { tool_name } = event.data;

  // Track tool usage patterns
  session.toolCalls = session.toolCalls || [];
  session.toolCalls.push({ tool: tool_name, timestamp: event.timestamp });

  // Detect infinite loops: same tool called 10+ times in 1 minute
  const recentCalls = session.toolCalls.filter(t =>
    Date.now() - new Date(t.timestamp).getTime() < 60 * 1000
  );

  const toolCounts = {};
  for (const call of recentCalls) {
    toolCounts[call.tool] = (toolCounts[call.tool] || 0) + 1;
  }

  for (const [tool, count] of Object.entries(toolCounts)) {
    if (count >= 10) {
      await emitAlert({
        type: 'tool_loop',
        attempt_id: session.attempt_id,
        tool_name: tool,
        occurrences: count,
        recommendation: 'fresh_session'
      });
    }
  }
}

async function emitAlert(alert) {
  console.error(`[ALERT] ${alert.type}: ${JSON.stringify(alert)}`);

  // Write to alerts file for openfleet to consume
  const alertEntry = {
    timestamp: new Date().toISOString(),
    ...alert
  };

  await appendFile(
    '.cache/agent-work-logs/agent-alerts.jsonl',
    JSON.stringify(alertEntry) + '\n'
  );
}

export { tailAgentWorkStream };
```

#### 2.2 Integration with openfleet

**In `monitor.mjs`:**
```javascript
import { tailAgentWorkStream } from './agent-work-analyzer.mjs';

// Start analyzer in background
void tailAgentWorkStream();

// Poll for alerts
setInterval(async () => {
  const alerts = await readNewAlerts('.cache/agent-work-logs/agent-alerts.jsonl');
  for (const alert of alerts) {
    await handleAgentAlert(alert);
  }
}, 5000); // Check every 5s

async function handleAgentAlert(alert) {
  if (alert.type === 'error_loop' && alert.recommendation === 'trigger_ai_autofix') {
    // Trigger AI autofix flow
    await initiateAutoFix(alert.attempt_id, alert.error_fingerprint);
  }

  if (alert.type === 'tool_loop' && alert.recommendation === 'fresh_session') {
    // Trigger fresh session
    await requestFreshSession(alert.attempt_id, 'tool_loop_detected');
  }

  // Send Telegram notification
  await notify(`⚠️ Alert: ${alert.type} detected on ${alert.attempt_id}`, {
    priority: 2, // Error priority
    category: 'agent_health'
  });
}
```

### Phase 3: Offline Analytics (Week 3-4)

**Goal:** Enable backtesting and strategy improvement

#### 3.1 Analytics CLI Tool

**New file:** `scripts/openfleet/analyze-agent-work.mjs`

```javascript
#!/usr/bin/env node

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

// Usage:
//   npm run analyze -- --backlog-tasks 10 --metric success-rate
//   npm run analyze -- --error-clustering --days 7
//   npm run analyze -- --executor-comparison CODEX COPILOT
//   npm run analyze -- --task-planning --failed-only

async function analyzeBacklog(options) {
  const tasks = await loadTasks(options.limit || 10);

  for (const task of tasks) {
    const sessions = await loadTaskSessions(task.task_id);
    const analysis = {
      task_id: task.task_id,
      task_title: task.task_title,
      total_attempts: sessions.length,
      success: sessions.some(s => s.outcome?.status === 'completed'),
      avg_duration_ms: average(sessions.map(s => s.metrics?.duration_ms)),
      total_cost_usd: sum(sessions.map(s => s.metrics?.cost_usd)),

      // Identify improvement opportunities
      common_errors: extractCommonErrors(sessions),
      prompt_effectiveness: analyzePromptChanges(sessions),
      executor_performance: groupBy(sessions, 'executor')
    };

    console.log(formatTaskAnalysis(analysis));
  }
}

async function clusterErrors(options) {
  const errors = await loadErrors({ days: options.days || 7 });

  // Group by error_fingerprint
  const clusters = groupBy(errors, e => e.data.error_fingerprint);

  // Sort by frequency
  const sorted = Object.entries(clusters)
    .map(([fingerprint, events]) => ({
      fingerprint,
      count: events.length,
      affected_tasks: new Set(events.map(e => e.task_id)).size,
      first_seen: events[0].timestamp,
      last_seen: events[events.length - 1].timestamp,
      sample_message: events[0].data.error_message
    }))
    .sort((a, b) => b.count - a.count);

  console.log('\n=== Error Clustering Analysis ===\n');
  for (const cluster of sorted.slice(0, 20)) {
    console.log(`${cluster.fingerprint}: ${cluster.count} occurrences across ${cluster.affected_tasks} tasks`);
    console.log(`  Sample: ${cluster.sample_message.slice(0, 100)}...`);
    console.log(`  First: ${cluster.first_seen}, Last: ${cluster.last_seen}\n`);
  }
}

async function compareExecutors(executors) {
  const sessions = await loadAllSessions();

  const comparison = {};
  for (const executor of executors) {
    const executorSessions = sessions.filter(s => s.executor === executor);

    comparison[executor] = {
      total_sessions: executorSessions.length,
      success_rate: percentage(executorSessions, s => s.outcome?.status === 'completed'),
      first_shot_rate: percentage(executorSessions, s => s.metrics?.first_shot_success),
      avg_duration_ms: average(executorSessions.map(s => s.metrics?.duration_ms)),
      avg_cost_usd: average(executorSessions.map(s => s.metrics?.cost_usd)),
      avg_tokens: average(executorSessions.map(s => s.metrics?.total_tokens)),
      common_failures: topN(
        groupBy(
          executorSessions.filter(s => !s.outcome?.status === 'completed'),
          s => s.error_summary?.error_fingerprints?.[0]
        ),
        5
      )
    };
  }

  console.log('\n=== Executor Comparison ===\n');
  console.table(comparison);
}

async function analyzePlanning(options) {
  const failedTasks = await loadFailedTasks();

  for (const task of failedTasks) {
    const sessions = await loadTaskSessions(task.task_id);

    console.log(`\n=== Task: ${task.task_title} ===`);
    console.log(`Status: ${task.status} | Attempts: ${sessions.length}`);

    // Analyze what went wrong
    const rootCauses = sessions.flatMap(s => s.error_summary?.error_categories || []);
    const categoryFreq = countFrequency(rootCauses);

    console.log(`\nRoot Cause Categories:`);
    for (const [category, count] of Object.entries(categoryFreq)) {
      console.log(`  ${category}: ${count}`);
    }

    // Identify planning issues
    const planningIssues = [];

    if (categoryFreq['dependency']) {
      planningIssues.push('Missing dependency setup in task description');
    }
    if (categoryFreq['api_key']) {
      planningIssues.push('Missing environment setup instructions');
    }
    if (categoryFreq['context_window']) {
      planningIssues.push('Task scope too large, should be broken into subtasks');
    }

    if (planningIssues.length > 0) {
      console.log(`\n💡 Planning Improvements:`);
      for (const issue of planningIssues) {
        console.log(`  - ${issue}`);
      }
    }
  }
}

// CLI argument parsing
const args = process.argv.slice(2);
const command = args[0];

if (command === '--backlog-tasks') {
  await analyzeBacklog({ limit: parseInt(args[1]) });
} else if (command === '--error-clustering') {
  await clusterErrors({ days: parseInt(args[2]) });
} else if (command === '--executor-comparison') {
  await compareExecutors(args.slice(1));
} else if (command === '--task-planning') {
  await analyzePlanning({ failedOnly: args.includes('--failed-only') });
} else {
  console.log(`
Usage:
  node analyze-agent-work.mjs --backlog-tasks <N>
  node analyze-agent-work.mjs --error-clustering --days <N>
  node analyze-agent-work.mjs --executor-comparison CODEX COPILOT ...
  node analyze-agent-work.mjs --task-planning [--failed-only]
  `);
}
```

#### 3.2 Automated Weekly Reports

**In `monitor.mjs` (or new cron job):**
```javascript
// Generate weekly performance report
async function generateWeeklyReport() {
  const report = {
    period: { start: startOfWeek(), end: endOfWeek() },
    summary: {
      total_tasks: await countTasks(),
      completed_tasks: await countCompletedTasks(),
      success_rate: await calculateSuccessRate(),
      avg_time_to_completion_hours: await avgTimeToCompletion()
    },
    executors: await compareExecutors(['CODEX', 'COPILOT']),
    top_errors: await topErrors(10),
    planning_insights: await analyzePlanningPatterns()
  };

  // Save to file
  await writeFile(
    `.cache/reports/weekly-${formatDate(new Date())}.json`,
    JSON.stringify(report, null, 2)
  );

  // Send to Telegram
  await notify(formatWeeklyReport(report), {
    priority: 4,
    category: 'weekly_report'
  });
}

// Schedule weekly reports (Sunday at 9 AM)
schedule.scheduleJob('0 9 * * 0', generateWeeklyReport);
```

## Configuration

**Environment variables (.env):**
```bash
# Agent work logging
AGENT_WORK_LOGGING_ENABLED=true
AGENT_WORK_LOG_DIR=.cache/agent-work-logs
AGENT_WORK_STREAM_FILE=agent-work-stream.jsonl
AGENT_SESSION_LOG_RETENTION=100  # Keep last N session logs
AGENT_WORK_LOG_MAX_SIZE_MB=500   # Rotate logs at this size

# Live analysis
AGENT_WORK_ANALYZER_ENABLED=true
AGENT_WORK_ANALYZER_POLL_INTERVAL_MS=5000
AGENT_ERROR_LOOP_THRESHOLD=4     # Trigger alert after N repeating errors
AGENT_TOOL_LOOP_THRESHOLD=10     # Trigger alert after N tool calls/min

# Offline analytics
AGENT_ANALYTICS_WEEKLY_REPORT=true
AGENT_ANALYTICS_REPORT_DAY=0     # 0=Sunday
AGENT_ANALYTICS_REPORT_HOUR=9
```

## Data Retention & Rotation

**Log rotation strategy:**
- `agent-work-stream.jsonl` - Keep last 30 days, rotate daily
- `agent-sessions/*.jsonl` - Keep last 100 sessions
- `agent-errors.jsonl` - Keep last 90 days
- `agent-metrics.jsonl` - Keep indefinitely (compressed monthly)

**Rotation script:** `scripts/openfleet/rotate-agent-logs.sh`
```bash
#!/bin/bash
# Rotate agent work logs

LOG_DIR=".cache/agent-work-logs"
RETENTION_DAYS=30

# Archive main stream log
if [ -f "$LOG_DIR/agent-work-stream.jsonl" ]; then
  ARCHIVE_NAME="agent-work-stream-$(date +%Y%m%d).jsonl.gz"
  gzip -c "$LOG_DIR/agent-work-stream.jsonl" > "$LOG_DIR/archive/$ARCHIVE_NAME"
  > "$LOG_DIR/agent-work-stream.jsonl"  # Truncate
fi

# Clean old archives
find "$LOG_DIR/archive" -name "*.jsonl.gz" -mtime +$RETENTION_DAYS -delete

# Clean old session logs (keep last 100)
ls -t "$LOG_DIR/agent-sessions/"*.jsonl | tail -n +101 | xargs rm -f

echo "Agent work logs rotated: $(date)"
```

## Success Metrics

**KPIs to track:**
- **Error Detection Latency:** Time from error occurrence to alert (target: <30s)
- **Intervention Success Rate:** % of auto-interventions that resolve issues
- **Analysis Coverage:** % of agent sessions with complete logs
- **Analytics Utilization:** Weekly report engagement (opens, actions taken)
- **Cost Savings:** Reduced token waste from early error detection

## Rollout Plan

**Week 1:**
- ✓ Implement basic log capture (session start/end, errors)
- ✓ Create `.cache/agent-work-logs/` structure
- ✓ Test JSONL append performance

**Week 2:**
- ✓ Deploy live stream analyzer
- ✓ Integrate alerts with openfleet
- ✓ Test error loop detection in production

**Week 3:**
- ✓ Build analytics CLI tool
- ✓ Run backlog analysis on last 30 days
- ✓ Generate first insights report

**Week 4:**
- ✓ Implement automated weekly reports
- ✓ Set up log rotation
- ✓ Documentation & training

## Next Steps

1. **Review this design doc** - Confirm approach aligns with goals
2. **Prototype log capture** - Start with minimal JSONL logging in ve-orchestrator.ps1
3. **Validate log format** - Ensure all required metadata is captured
4. **Build analyzer PoC** - Simple tail + pattern matching
5. **Iterate based on findings** - Refine error patterns, alert thresholds

---

**Document version:** 1.0
**Last updated:** 2026-02-09
**Owner:** VirtEngine OpenFleet Team
