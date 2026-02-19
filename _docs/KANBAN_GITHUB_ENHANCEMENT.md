# Kanban Adapter GitHub Enhancement - Documentation

## Overview

Enhanced `scripts/openfleet/kanban-adapter.mjs` GitHubAdapter with shared state persistence capabilities for multi-agent coordination via GitHub issues.

> **Note**: This document covers **issue-level** shared state persistence (labels + comments).  
> For **GitHub Projects v2** integration (reading from project boards, syncing status to project fields), see:
>
> - [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md) - Complete API reference and implementation guide
> - [GITHUB_PROJECTS_V2_QUICKSTART.md](./GITHUB_PROJECTS_V2_QUICKSTART.md) - Quick start guide

## Changes Summary

### 1. New Label Scheme

Added openfleet specific labels to track agent state:

- `codex:claimed` - Task has been claimed by an agent
- `codex:working` - Agent is actively working on the task
- `codex:stale` - Claim has expired or been abandoned
- `codex:ignore` - Task explicitly excluded from openfleet automation

These labels coexist with existing status labels (`inprogress`, `inreview`, etc.).

### 2. Structured Comment Format

Agent state is persisted as HTML comments with embedded JSON:

```markdown
<!-- openfleet-state
{
  "ownerId": "workstation-123/agent-456",
  "attemptToken": "uuid-here",
  "attemptStarted": "2026-02-14T17:00:00Z",
  "heartbeat": "2026-02-14T17:30:00Z",
  "status": "working",
  "retryCount": 1
}
-->

**OpenFleet Status**: Agent `agent-456` on `workstation-123` is working on this task.
_Last heartbeat: 2026-02-14T17:30:00Z_
```

The JSON is hidden in HTML comments for clean rendering, while the visible text provides human-readable status.

### 3. New GitHubAdapter Methods

#### `persistSharedStateToIssue(issueNumber, sharedState)`

Persists agent state to a GitHub issue by:

1. Updating labels based on `sharedState.status`
2. Creating or updating the structured comment

**Parameters:**

- `issueNumber` (string|number) - GitHub issue number
- `sharedState` (SharedState) - State object with required fields:
  - `ownerId` - Workstation/agent identifier (e.g., "workstation-123/agent-456")
  - `attemptToken` - Unique UUID for this claim attempt
  - `attemptStarted` - ISO 8601 timestamp of claim start
  - `heartbeat` - ISO 8601 timestamp of last heartbeat
  - `status` - Current status: "claimed" | "working" | "stale"
  - `retryCount` - Number of retry attempts

**Returns:** `Promise<boolean>` - Success status

**Error Handling:** Retries once on failure, logs and continues on second failure

**Example:**

```javascript
await adapter.persistSharedStateToIssue(123, {
  ownerId: "workstation-123/agent-456",
  attemptToken: "uuid-here",
  attemptStarted: "2026-02-14T17:00:00Z",
  heartbeat: "2026-02-14T17:30:00Z",
  status: "working",
  retryCount: 1,
});
```

#### `readSharedStateFromIssue(issueNumber)`

Reads the latest shared state from a GitHub issue.

**Parameters:**

- `issueNumber` (string|number) - GitHub issue number

**Returns:** `Promise<SharedState|null>` - Parsed state or null if not found

**Example:**

```javascript
const state = await adapter.readSharedStateFromIssue(123);
if (state) {
  console.log(`Task claimed by ${state.ownerId}`);
  console.log(`Last heartbeat: ${state.heartbeat}`);
}
```

#### `markTaskIgnored(issueNumber, reason)`

Marks a task as ignored by openfleet.

**Parameters:**

- `issueNumber` (string|number) - GitHub issue number
- `reason` (string) - Human-readable reason for ignoring

**Returns:** `Promise<boolean>` - Success status

**Example:**

```javascript
await adapter.markTaskIgnored(123, "Task requires manual security review");
```

### 4. Enhanced Existing Methods

#### `updateTaskStatus(issueNumber, status, options?)`

Now accepts optional `options` parameter:

- `options.sharedState` (SharedState) - If provided, syncs shared state after status update

**Example:**

```javascript
await adapter.updateTaskStatus(123, "inprogress", {
  sharedState: {
    ownerId: "workstation-123/agent-456",
    attemptToken: "uuid",
    attemptStarted: "2026-02-14T17:00:00Z",
    heartbeat: "2026-02-14T17:00:00Z",
    status: "working",
    retryCount: 0,
  },
});
```

#### `listTasks(projectId, filters?)` and `getTask(issueNumber)`

Both methods now automatically enrich task metadata with shared state when available:

```javascript
const tasks = await adapter.listTasks("virtengine/virtengine");
tasks.forEach((task) => {
  if (task.meta.sharedState) {
    console.log(`Task ${task.id} claimed by ${task.meta.sharedState.ownerId}`);
  }
  if (task.meta.codex.isIgnored) {
    console.log(`Task ${task.id} is ignored by openfleet`);
  }
});
```

Task metadata now includes:

- `task.meta.sharedState` (SharedState|undefined) - Agent state if present
- `task.meta.codex` (object) - Codex label flags:
  - `isIgnored` (boolean)
  - `isClaimed` (boolean)
  - `isWorking` (boolean)
  - `isStale` (boolean)

### 5. Module-Level Exports

Added convenience functions that delegate to the active adapter:

```javascript
import {
  persistSharedStateToIssue,
  readSharedStateFromIssue,
  markTaskIgnored,
} from "./kanban-adapter.mjs";

// These work with GitHub backend, log warning for others
await persistSharedStateToIssue(123, sharedState);
const state = await readSharedStateFromIssue(123);
await markTaskIgnored(123, "Manual review required");
```

### 6. Private Helper Methods

Added to GitHubAdapter:

- `_getIssueLabels(issueNumber)` - Fetch current labels
- `_getIssueComments(issueNumber)` - Fetch all comments

## Backward Compatibility

All changes maintain full backward compatibility:

- Existing GitHubAdapter API unchanged
- VKAdapter and JiraAdapter unaffected
- New methods only available on GitHubAdapter
- Module exports gracefully handle non-GitHub backends
- `updateTaskStatus()` accepts optional third parameter

## Error Handling

Robust error handling throughout:

1. **Label operations**: Retry once, log and continue on failure
2. **Comment operations**: Retry once, log and continue on failure
3. **State parsing**: Validate required fields, return null on invalid data
4. **Invalid issue numbers**: Throw descriptive errors
5. **Backend compatibility**: Log warnings when methods unavailable

## Usage Patterns

### Multi-Agent Coordination

```javascript
import { getKanbanAdapter } from "./kanban-adapter.mjs";

const adapter = getKanbanAdapter();

// Agent claims task
await adapter.persistSharedStateToIssue(123, {
  ownerId: "ws-1/agent-1",
  attemptToken: "uuid-1",
  attemptStarted: new Date().toISOString(),
  heartbeat: new Date().toISOString(),
  status: "claimed",
  retryCount: 0,
});

// Check if task already claimed
const state = await adapter.readSharedStateFromIssue(123);
if (state && state.status === "working") {
  console.log(`Task already claimed by ${state.ownerId}`);
  return;
}

// Update heartbeat periodically
setInterval(async () => {
  const currentState = await adapter.readSharedStateFromIssue(123);
  if (currentState) {
    await adapter.persistSharedStateToIssue(123, {
      ...currentState,
      heartbeat: new Date().toISOString(),
    });
  }
}, 30000);
```

### Filtering Tasks

```javascript
const tasks = await adapter.listTasks("virtengine/virtengine");

// Find unclaimed tasks
const available = tasks.filter(
  (t) =>
    !t.meta.codex.isClaimed && !t.meta.codex.isIgnored && !t.meta.sharedState,
);

// Find stale tasks
const stale = tasks.filter((t) => {
  if (!t.meta.sharedState) return false;
  const lastHeartbeat = new Date(t.meta.sharedState.heartbeat);
  const now = new Date();
  return now - lastHeartbeat > 5 * 60 * 1000; // 5 minutes
});
```

### Ignore Management

```javascript
// Mark complex tasks as ignored
const complexTasks = tasks.filter(
  (t) => t.title.includes("security") || t.title.includes("refactor"),
);

for (const task of complexTasks) {
  await adapter.markTaskIgnored(
    task.id,
    "Complex task requiring human oversight",
  );
}
```

## Testing

Run validation test:

```bash
cd scripts/openfleet
node test-kanban-enhancement.mjs
```

The test validates:

- Module loads without errors
- New exports are available
- GitHubAdapter has all new methods
- Label scheme is correct
- VKAdapter unaffected
- SharedState structure is valid

## Implementation Notes

1. **Comment Updates**: Uses GitHub API directly via `gh api` for PATCH operations
2. **Label Management**: Ensures only one codex label active at a time
3. **State Parsing**: Uses regex to extract JSON from HTML comments
4. **Retry Logic**: Simple 1-second delay between retries
5. **JSON Formatting**: Pretty-printed for human readability in issue comments

## Future Enhancements

Potential improvements:

- Exponential backoff for retries
- Batch label/comment operations
- State history tracking (multiple comments)
- Webhook-based real-time updates
- Stale detection automation
- Task affinity based on agent capabilities
