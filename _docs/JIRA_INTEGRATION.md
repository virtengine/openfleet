# Jira Integration Guide for OpenFleet

This guide documents Jira configuration parity for openfleet, including status mapping and shared-state field mapping.

## Overview

Jira integration uses the same openfleet shared-state contract used by other backends:

- `ownerId`
- `attemptToken`
- `attemptStarted`
- `heartbeat`
- `status`
- `retryCount`

Shared-state lifecycle labels are also consistent:

- `codex:claimed`
- `codex:working`
- `codex:stale`
- `codex:ignore`

## Interactive Setup (recommended)

Run the setup wizard and select Jira:

```bash
openfleet --setup
```

The wizard can (opt-in):

- open the Atlassian API token page
- validate credentials by calling the Jira API
- list Jira projects and let you pick one by name/key
- open the Jira Projects page if you want to create a new project
- look up issue types and custom fields for shared state
- set defaults for assignee, labels/tags, and task type

This keeps Jira setup from being a manual "enter a key" process.

## Required Jira Auth

```bash
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-api-token
KANBAN_BACKEND=jira
```

## Project + Issue Type Defaults

```bash
JIRA_PROJECT_KEY=ENG
JIRA_ISSUE_TYPE=Task
```

Optional subtask support (requires a parent issue key):

```bash
JIRA_SUBTASK_PARENT_KEY=ENG-1
```

Optional default assignee (Jira account ID):

```bash
JIRA_DEFAULT_ASSIGNEE=5b10a2844c20165700ede21g
```

## Task Scoping + Tags

OpenFleet scopes Jira tasks using labels. These are effectively your tags.

```bash
JIRA_TASK_LABELS=openfleet,codex-mointor
JIRA_ENFORCE_TASK_LABEL=true
```

Notes:

- Jira labels are sanitized to lowercase and non-alphanumeric characters become `-`.
- If you set `JIRA_TASK_LABELS`, only issues with those labels are pulled into OpenFleet.
- Extra tags can be applied in Jira as labels; they will be preserved and exposed in task metadata.

## Comments + Fetch Limits

```bash
JIRA_USE_ADF_COMMENTS=true
JIRA_ISSUES_LIST_LIMIT=250
```

`JIRA_USE_ADF_COMMENTS` controls whether comments are written in Atlassian Document
Format (default: true). The list limit caps how many issues are fetched per poll.

## Status Mapping Env Vars

Map internal openfleet statuses to Jira workflow status names:

```bash
JIRA_STATUS_TODO=To Do
JIRA_STATUS_INPROGRESS=In Progress
JIRA_STATUS_INREVIEW=In Review
JIRA_STATUS_DONE=Done
JIRA_STATUS_CANCELLED=Cancelled
```

These should match the exact status names configured in your Jira workflow.

## Shared-State Field Mapping Env Vars

Use Jira custom field IDs for shared-state persistence. You can store the full
JSON payload in a single custom field, or map individual fields.

```bash
JIRA_CUSTOM_FIELD_SHARED_STATE=customfield_10041
JIRA_CUSTOM_FIELD_OWNER_ID=customfield_10042
JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN=customfield_10043
JIRA_CUSTOM_FIELD_ATTEMPT_STARTED=customfield_10044
JIRA_CUSTOM_FIELD_HEARTBEAT=customfield_10045
JIRA_CUSTOM_FIELD_RETRY_COUNT=customfield_10046
JIRA_CUSTOM_FIELD_IGNORE_REASON=customfield_10047
```

If custom fields are not configured, keep these unset and use structured-comment
fallback. OpenFleet will still update labels and comments.

## Shared-State Labels

```bash
JIRA_LABEL_CLAIMED=codex:claimed
JIRA_LABEL_WORKING=codex:working
JIRA_LABEL_STALE=codex:stale
JIRA_LABEL_IGNORE=codex:ignore
```

Note: Jira normalizes labels; `codex:claimed` becomes `codex-claimed`.

## Example `.env` Block

```bash
KANBAN_BACKEND=jira

JIRA_BASE_URL=https://acme.atlassian.net
JIRA_EMAIL=codex-bot@acme.com
JIRA_API_TOKEN=***

JIRA_PROJECT_KEY=ENG
JIRA_ISSUE_TYPE=Task
JIRA_SUBTASK_PARENT_KEY=ENG-1
JIRA_DEFAULT_ASSIGNEE=5b10a2844c20165700ede21g

JIRA_STATUS_TODO=To Do
JIRA_STATUS_INPROGRESS=In Progress
JIRA_STATUS_INREVIEW=In Review
JIRA_STATUS_DONE=Done
JIRA_STATUS_CANCELLED=Cancelled

JIRA_LABEL_CLAIMED=codex:claimed
JIRA_LABEL_WORKING=codex:working
JIRA_LABEL_STALE=codex:stale
JIRA_LABEL_IGNORE=codex:ignore
JIRA_TASK_LABELS=openfleet,codex-mointor
JIRA_ENFORCE_TASK_LABEL=true
JIRA_USE_ADF_COMMENTS=true
JIRA_ISSUES_LIST_LIMIT=250

JIRA_CUSTOM_FIELD_SHARED_STATE=customfield_10041
JIRA_CUSTOM_FIELD_OWNER_ID=customfield_10042
JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN=customfield_10043
JIRA_CUSTOM_FIELD_ATTEMPT_STARTED=customfield_10044
JIRA_CUSTOM_FIELD_HEARTBEAT=customfield_10045
JIRA_CUSTOM_FIELD_RETRY_COUNT=customfield_10046
JIRA_CUSTOM_FIELD_IGNORE_REASON=customfield_10047
```

## Example Shared-State Payload

```json
{
  "ownerId": "workstation-12/codex-primary",
  "attemptToken": "550e8400-e29b-41d4-a716-446655440000",
  "attemptStarted": "2026-02-17T15:05:00.000Z",
  "heartbeat": "2026-02-17T15:12:00.000Z",
  "status": "working",
  "retryCount": 1
}
```

## Jira Capabilities Used by OpenFleet

OpenFleet maps task metadata to Jira fields wherever possible:

- Status: mapped via `JIRA_STATUS_*` to keep workflow states aligned.
- Tags/labels: `JIRA_TASK_LABELS` scopes tasks; additional labels are preserved.
- Assignee: `JIRA_DEFAULT_ASSIGNEE` sets an account ID for new tasks.
- Priority: `priority` values on tasks map to Jira priority names.
- Subtasks: set `JIRA_ISSUE_TYPE` to a sub-task type and provide `JIRA_SUBTASK_PARENT_KEY`.
- Comments: shared-state comments include heartbeat info and agent ownership.

Other backends follow the same metadata shape (status, labels/tags, assignee,
priority) where supported. VK currently exposes status/description only.

## Collaboration + Multi-Workstation Sync

OpenFleet coordinates multiple workstations via shared state stored in Jira:

- Each task claim writes `ownerId`, `attemptToken`, `heartbeat`, and status.
- Heartbeats refresh periodically; stale heartbeats are marked `codex:stale`.
- New sessions detect stale claims and can safely resume or reassign tasks.
- Shared-state comments act as a lightweight coordination channel.
- Telegram is used for human-visible notifications; task state sync stays in Jira.

For manual recovery, run a stale sweep or mark tasks ignored with `codex:ignore`.

## Config File Equivalent (`openfleet.config.json`)

```json
{
  "kanban": {
    "backend": "jira",
    "jira": {
      "baseUrl": "https://acme.atlassian.net",
      "email": "codex-bot@acme.com",
      "projectKey": "ENG",
      "issueType": "Task",
      "statusMapping": {
        "todo": "To Do",
        "inprogress": "In Progress",
        "inreview": "In Review",
        "done": "Done",
        "cancelled": "Cancelled"
      },
      "labels": {
        "claimed": "codex:claimed",
        "working": "codex:working",
        "stale": "codex:stale",
        "ignore": "codex:ignore"
      },
      "sharedStateFields": {
        "ownerId": "customfield_10042",
        "attemptToken": "customfield_10043",
        "attemptStarted": "customfield_10044",
        "heartbeat": "customfield_10045",
        "retryCount": "customfield_10046",
        "ignoreReason": "customfield_10047"
      }
    }
  }
}
```

## Validation Checklist

- `JIRA_STATUS_*` values exactly match workflow status names.
- `JIRA_CUSTOM_FIELD_*` values are valid Jira custom field IDs.
- Jira automation/bot user has permissions to browse, edit, and comment on issues.
- `KANBAN_BACKEND=jira` is set in the active runtime profile.
- `JIRA_TASK_LABELS` includes your codex scope label and `JIRA_ENFORCE_TASK_LABEL=true`.
- If using subtasks, `JIRA_SUBTASK_PARENT_KEY` is a valid issue key.
- If using default assignee, `JIRA_DEFAULT_ASSIGNEE` is a Jira account ID.
