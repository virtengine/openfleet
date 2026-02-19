# GitHub Projects v2 Monitoring Guide

**Scope**: Operational monitoring for Projects v2 read/write sync in `scripts/openfleet/kanban-adapter.mjs`.

---

## What to Monitor

### 1. Read Path Health (Project -> openfleet)

Watch for read failures when `GITHUB_PROJECT_MODE=kanban`:

- `failed to list tasks from project`
- `project item-list returned non-array`
- `failed to fetch project fields`

Expected behavior on failure: adapter logs warning and falls back to issue-based listing.

### 2. Write Path Health (openfleet -> Project)

Watch sync outcomes from `updateTaskStatus()` auto-sync:

- Success signal: `synced issue ... to project status`
- Field sync success: `synced field "..."`
- Failure signals:
  - `failed to sync status to project`
  - `cannot sync to project: no status field found`
  - `issue not found in project`
  - `no matching project status`

### 3. Rate Limit Pressure

Watch for:

- `rate limit detected, waiting 60s before retry`
- `gh CLI failed (after rate limit retry)`

If frequent, reduce sync churn and verify GitHub token scopes/quota.

---

## Quick Log Checks

Run from repo root:

```bash
# Recent Projects v2 related logs
rg -n "project|sync status|syncFieldToProject|rate limit" scripts/openfleet/logs -g "*.log"

# Failure-focused scan
rg -n "failed to sync status to project|failed to list tasks from project|rate limit" scripts/openfleet/logs -g "*.log"

# Success-focused scan
rg -n "synced issue .* to project status|synced field" scripts/openfleet/logs -g "*.log"
```

---

## Recommended SLO Signals

- Read availability: `% of polling cycles without project read failure`
- Sync success rate: `successful status syncs / attempted status syncs`
- Rate-limit incidence: `rate-limit events per hour`
- Fallback frequency: `project->issues fallback count per hour`

Built-in metrics are exposed via `GET /api/project-sync/metrics` (served by `ui-server.mjs`) and include webhook counters plus sync-engine counters.

---

## Alerting Guidance

Set alert rules in your log pipeline and/or consume built-in alert hooks:

- Repeated sync failures (`>=5` in 10 minutes)
- Any `after rate limit retry` failure
- Sustained fallback to issues mode (`>=10` fallback warnings in 30 minutes)

Built-in thresholds:

- `GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD` (default `3`)
- `GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD` (default `3`)

Escalation recommendation:

1. Verify `GITHUB_PROJECT_OWNER` and `GITHUB_PROJECT_NUMBER`.
2. Verify `gh auth status` includes `project` scope.
3. Validate project fields with `gh project field-list <number> --owner <owner> --format json`.
4. Confirm `Status` option names match configured `GITHUB_PROJECT_STATUS_*` values.

---

## Configuration Checks

Required for Projects mode:

```env
KANBAN_BACKEND=github
GITHUB_PROJECT_MODE=kanban
GITHUB_PROJECT_OWNER=<owner>
GITHUB_PROJECT_NUMBER=<number>
```

Optional but recommended:

```env
GITHUB_PROJECT_AUTO_SYNC=true
GH_RATE_LIMIT_RETRY_MS=60000
```

---

## Backward Compatibility Notes

- `GITHUB_PROJECT_MODE=issues` remains default behavior.
- If project sync fails, issue updates still proceed.
- VK/Jira backends are unaffected by Projects v2 settings.
