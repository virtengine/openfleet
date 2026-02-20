# Telemetry Usage Guide

This document explains the telemetry fields bosun records, how they can be used for interventions, and how to build analytics pipelines from them. The data is intentionally verbose for a limited retention window so we can improve orchestration quality and model selection over time.

## Where Data Lives

- `.cache/agent-work-logs/agent-work-stream.jsonl`
  - Append-only event stream for all internal SDK runs.
- `.cache/agent-work-logs/agent-errors.jsonl`
  - Error-only subset for fast clustering.
- `.cache/agent-work-logs/agent-metrics.jsonl`
  - Session-level rollups with merged telemetry and outcomes.
- `.cache/agent-work-logs/agent-alerts.jsonl`
  - Analyzer alerts (loop/stall/cost anomalies) with severity.

## Event Types

Each JSONL entry includes:
- `timestamp`
- `attempt_id`, `task_id`, `task_title`
- `executor`, `executor_variant`, `model`
- `event_type` (one of below)
- `data` (event-specific payload)

### `session_start`
Tracks prompt start, initial metadata.
- **Use**: attempts per task, prompt impact analysis, retry vs. first-shot metrics.

### `agent_output`
Normalized output text.
- **Use**: detect plan-stuck, identify verbosity, parse “completed” claims vs. git activity.

### `tool_call`
Tool usage telemetry.
- **Use**: tool loop detection, tool selection optimization, identify missing tools.

### `tool_result`
Tool outcome and failure status.
- **Use**: tool reliability scoring, tool-specific failure clustering.

### `error`
Error classification payload.
- **Fields**: `error_message`, `error_category`, `error_fingerprint`, `error_confidence`.
- **Use**: auto-retry gating, root cause tracking, provider failure detection.

### `usage`
Usage/cost fields if surfaced by SDK.
- **Fields**: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost_usd`.
- **Use**: cost anomaly detection, budget throttling, model value scoring.

### `session_end`
Rollup data for the attempt.
- **Fields**: duration, success, attempts, continues, tool stats, anomalies, diff stats.
- **Use**: quality benchmarks, throughput metrics, executor comparisons.

## Session Metrics (agent-metrics.jsonl)

Each entry merges telemetry with outcome data. Key fields:

### Execution Quality
- `metrics.success`
- `metrics.first_shot_success`
- `metrics.attempts`
- `metrics.continues`
- `metrics.auto_resume`
- `metrics.anomaly_actions[]`

**Use**:
- Identify “prompt needs fixes” when attempts > 1 and continues are high.
- Detect intervention efficacy (anomaly kill → success next attempt).

### Cost & Tokens
- `metrics.prompt_tokens`, `metrics.completion_tokens`, `metrics.total_tokens`
- `metrics.cost_usd`

**Use**:
- Per-model cost efficiency scoring.
- Detect runaway cost anomalies.
- Budget enforcement and automatic model downgrades.

### Tool & Command Reliability
- `metrics.tool_calls`, `metrics.tool_results`, `metrics.tool_failures`
- `metrics.commands`, `metrics.command_failures`

**Use**:
- Tool-level failure rates.
- Pinpoint tool loops and suggest fallback toolsets.

### Git / PR Context
- `metrics.agent_made_commits`
- `metrics.diff_summary`
- `metrics.diff_files_changed`
- `metrics.diff_lines_added`
- `metrics.diff_lines_deleted`

**Use**:
- Estimate task scope vs. outputs.
- Catch “no-change” success claims.
- Feed review agent with richer diff context.

## Recommended Analytics Pipelines

### 1) Model Quality Scoring
- Group by `model` or `executor_variant`.
- Score = success_rate - (avg_cost_usd × weight) - (avg_errors × weight).
- Flag models with high error categories or high retry rates.

### 2) Task Planning Risk Detection
- Identify tasks with:
  - high `attempts`
  - high `tool_failures`
  - repeated `error_category` values
- Feed planner to split tasks or inject missing setup instructions.

### 3) Provider Reliability Heatmap
- Group errors by `error_category` for each executor.
- Track spikes of `rate_limit`, `api_error`, `model_error`.
- Use for dynamic routing away from unstable providers.

### 4) Intervention Effectiveness
- Compare success rates for attempts with `anomaly_actions` vs without.
- Track `auto_resume` effectiveness (did it lead to success?).

### 5) Guardrail Gaps
- If failures cluster around `permission_wait`, `auth`, `content_policy`:
  - add prompt guardrails
  - update environment instructions
  - preflight checks before dispatch

## Suggested Future Extensions

- Add “test_run” and “lint_run” counters based on command telemetry.
- Track “files_touched” and “hot files” for risk exposure.
- Store per‑tool latency to detect slow tool regressions.
- Persist “review outcome” into metrics (`review_passed`, `review_failed`).


## SDK Usage Field Notes

Bosun collects usage on a best‑effort basis by scanning SDK events. Field names vary by SDK and version, so we normalize common variants:

### Codex SDK
- Likely fields: `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`, `usage.cost_usd`.
- Also checked: `item.usage`, `response.usage` on streamed events.
- **Action**: use as primary source of cost + token metrics.

### Copilot SDK
- Event payloads may include `data.usage` or `metrics.usage` depending on client version.
- Some builds only expose usage in a session summary event; we capture if present.
- **Action**: treat as optional; build model selection logic using whichever SDKs provide usage first.

### Claude SDK
- Claude streaming responses may include usage in `message.usage` or `result.usage`.
- We normalize `input_tokens` + `output_tokens` if found.
- **Action**: use tokens for cost estimation even if cost isn’t exposed directly.

If usage is missing, we still record duration, errors, tool counts, and outcomes so model quality scoring remains possible without cost data.
