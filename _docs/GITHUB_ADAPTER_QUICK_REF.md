# GitHub Adapter Quick Reference

> **Projects v2 Integration**: For reading from project boards and syncing status to project fields, see:
>
> - [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md) - Full API guide
> - [GITHUB_PROJECTS_V2_QUICKSTART.md](./GITHUB_PROJECTS_V2_QUICKSTART.md) - Quick start

## Label Scheme

| Label           | Meaning                    | Applied When                      |
| --------------- | -------------------------- | --------------------------------- |
| `codex:claimed` | Agent has claimed the task | `state.status === "claimed"`      |
| `codex:working` | Agent actively working     | `state.status === "working"`      |
| `codex:stale`   | Claim expired/abandoned    | `state.status === "stale"`        |
| `codex:ignore`  | Excluded from automation   | Manual or via `markTaskIgnored()` |

## API Reference

### Persist State

```javascript
await persistSharedStateToIssue(issueNumber, {
  ownerId: "workstation-123/agent-456",
  attemptToken: "uuid",
  attemptStarted: "2026-02-14T17:00:00Z",
  heartbeat: "2026-02-14T17:00:00Z",
  status: "working", // "claimed" | "working" | "stale"
  retryCount: 0,
});
```

### Read State

```javascript
const state = await readSharedStateFromIssue(issueNumber);
if (state) {
  console.log(`Claimed by: ${state.ownerId}`);
  console.log(`Status: ${state.status}`);
  console.log(`Last heartbeat: ${state.heartbeat}`);
}
```

### Mark Ignored

```javascript
await markTaskIgnored(issueNumber, "Requires manual security review");
```

### Update Status with State

```javascript
await updateTaskStatus(issueNumber, "inprogress", {
  sharedState: {
    ownerId: "ws-1/agent-1",
    attemptToken: "uuid",
    attemptStarted: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    status: "working",
    retryCount: 0,
  },
});
```

### Filter Tasks

```javascript
const tasks = await listTasks("virtengine/virtengine");

// Available (unclaimed, not ignored)
const available = tasks.filter(
  (t) => !t.meta.codex.isClaimed && !t.meta.codex.isIgnored,
);

// Stale (no heartbeat in 5 minutes)
const stale = tasks.filter((t) => {
  if (!t.meta.sharedState) return false;
  const age = Date.now() - new Date(t.meta.sharedState.heartbeat);
  return age > 5 * 60 * 1000;
});

// Explicitly ignored
const ignored = tasks.filter((t) => t.meta.codex.isIgnored);
```

## Task Metadata

Tasks from `listTasks()` and `getTask()` include:

```javascript
{
  id: "123",
  title: "Task title",
  // ... standard fields ...
  meta: {
    // Codex label flags
    codex: {
      isIgnored: false,
      isClaimed: true,
      isWorking: true,
      isStale: false
    },
    // Agent state (if present)
    sharedState: {
      ownerId: "workstation-123/agent-456",
      attemptToken: "uuid",
      attemptStarted: "2026-02-14T17:00:00Z",
      heartbeat: "2026-02-14T17:30:00Z",
      status: "working",
      retryCount: 0
    }
  }
}
```

## Comment Format

Structured comments in GitHub issues:

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

## Usage Patterns

### Claim Task

```javascript
// Check availability
const state = await readSharedStateFromIssue(123);
if (state && Date.now() - new Date(state.heartbeat) < 5 * 60 * 1000) {
  console.log("Already claimed");
  return;
}

// Claim it
await persistSharedStateToIssue(123, {
  ownerId: "ws-1/agent-1",
  attemptToken: randomUUID(),
  attemptStarted: new Date().toISOString(),
  heartbeat: new Date().toISOString(),
  status: "claimed",
  retryCount: 0,
});
```

### Send Heartbeat

```javascript
const state = await readSharedStateFromIssue(123);
if (state && state.ownerId === myId) {
  await persistSharedStateToIssue(123, {
    ...state,
    heartbeat: new Date().toISOString(),
  });
}
```

### Detect Stale Claims

```javascript
const tasks = await listTasks(projectId);
const staleTasks = tasks.filter((t) => {
  if (!t.meta.sharedState) return false;
  const lastHeartbeat = new Date(t.meta.sharedState.heartbeat);
  return Date.now() - lastHeartbeat > 5 * 60 * 1000;
});
```

## Error Handling

- All methods retry once on failure (1 second delay)
- Non-blocking in `listTasks()` and `getTask()` - logs warning and continues
- Returns `false` for failed persistence operations
- Returns `null` for failed read operations
- Unsupported backends log warning and return `false`/`null`

## Backend Compatibility

| Backend | Supported | Notes                               |
| ------- | --------- | ----------------------------------- |
| GitHub  | ✅ Yes    | Full support                        |
| VK      | ❌ No     | Methods not available, logs warning |
| Jira    | ❌ No     | Methods not available, logs warning |

## Environment Setup

```bash
# Switch to GitHub backend
export KANBAN_BACKEND=github

# Or in config
{
  "kanban": {
    "backend": "github"
  }
}
```

## See Also

- [KANBAN_GITHUB_ENHANCEMENT.md](./KANBAN_GITHUB_ENHANCEMENT.md) - Full documentation
- [example-multi-agent.mjs](./example-multi-agent.mjs) - Working examples
- [test-kanban-enhancement.mjs](./test-kanban-enhancement.mjs) - Validation tests
