# TUI WebSocket Event Contract

The Bosun TUI subscribes to the same local WebSocket endpoint as the portal: `/ws` on the `server/ui-server.mjs` HTTP server.

## Authentication

The TUI uses the same session token as the portal.

1. Bosun creates or reuses the UI session token during UI server startup.
2. The server persists the token to both:
   - `.bosun/.cache/ui-session-token.json`
   - `.bosun/.cache/ui-token`
3. The TUI resolves its token from:
   - `BOSUN_TUI_WS_TOKEN`
   - `BOSUN_UI_TOKEN`
   - `BOSUN_WS_TOKEN`
   - `.bosun/.cache/ui-token`
4. The TUI connects to `ws://127.0.0.1:<port>/ws` or `wss://.../ws` and passes the token as either:
   - `Authorization: Bearer <token>`
   - `?token=<token>`

No portal-specific workaround is required: the TUI reuses the same token and endpoint the portal already uses.

## Envelope

Every server-originated WS message uses the standard envelope:

```json
{
  "type": "monitor:stats",
  "channels": ["monitor", "stats", "tui"],
  "payload": {},
  "ts": 1774100000000
}
```

The TUI subscribes to the canonical event types below.

## Canonical Events

### `monitor:stats`

System-wide aggregate stats, emitted on connect and every 2 seconds from `server/ui-server.mjs` via the TUI stats emitter.

Payload schema:

```json
{
  "activeAgents": 2,
  "maxAgents": 5,
  "tokensIn": 150,
  "tokensOut": 50,
  "tokensTotal": 200,
  "throughputTps": 10,
  "uptimeMs": 123456,
  "rateLimits": {
    "openai": {
      "primary": 1000,
      "secondary": 500,
      "credits": 200,
      "unit": "tokens/min"
    }
  }
}
```

Emitter path:
- `server/ui-server.mjs` periodic stats emitter
- `infra/tui-bridge.mjs` `buildMonitorStatsPayload()`

### `sessions:update`

Full session snapshot, emitted on connect and whenever tracked session state changes.

Payload schema:

```json
[
  {
    "id": "session-1",
    "taskId": "task-1",
    "title": "Example session",
    "type": "task",
    "status": "active",
    "workspaceId": "workspace-1",
    "workspaceDir": "C:/repo/workspace-1",
    "branch": "feature/example",
    "turnCount": 3,
    "createdAt": "2026-03-21T12:00:00.000Z",
    "lastActiveAt": "2026-03-21T12:00:02.000Z",
    "idleMs": 0,
    "elapsedMs": 2000,
    "recommendation": "continue",
    "preview": "hello",
    "lastMessage": "hello",
    "insights": {}
  }
]
```

Emitter path:
- `infra/session-tracker.mjs` state listeners
- `server/ui-server.mjs` `broadcastTuiSessionsSnapshot()`

### `session:event`

Incremental per-session event, emitted for message activity and state changes.

Payload schema:

```json
{
  "sessionId": "session-1",
  "taskId": "task-1",
  "session": {
    "id": "session-1",
    "taskId": "task-1",
    "type": "task",
    "status": "active",
    "lastActiveAt": "2026-03-21T12:00:03.000Z",
    "turnCount": 4
  },
  "event": {
    "kind": "state",
    "reason": "session-updated"
  }
}
```

Emitter path:
- `infra/session-tracker.mjs` message/state listeners
- `server/ui-server.mjs` session WS bridge

### `logs:stream`

Structured log line emitted after a client sends `subscribe-logs`.

Payload schema:

```json
{
  "logType": "system",
  "query": "monitor",
  "filePath": "C:/tmp/monitor.log",
  "line": "2026-03-21T12:00:04.000Z info monitor heartbeat",
  "raw": "2026-03-21T12:00:04.000Z info monitor heartbeat",
  "level": "info",
  "timestamp": "2026-03-21T12:00:04.000Z"
}
```

Emitter path:
- `server/ui-server.mjs` log stream poller
- `infra/tui-bridge.mjs` `buildLogStreamPayload()`

### `workflow:status`

Workflow run state changes. Emitted at run start, node complete, run complete, and run error.

Payload schema:

```json
{
  "runId": "run-1",
  "workflowId": "workflow-1",
  "workflowName": "Test Workflow",
  "eventType": "node:complete",
  "status": "success",
  "nodeId": "node-1",
  "nodeType": "action.test",
  "nodeLabel": "Test Node",
  "error": null,
  "durationMs": 15,
  "timestamp": 1774100000000,
  "meta": {
    "attempt": 0
  }
}
```

Emitter path:
- `workflow/workflow-engine.mjs` `_emitWorkflowStatus()`
- `server/ui-server.mjs` workflow WS bridge

### `tasks:update`

Canonical task/kanban diff event derived from task invalidation and CRUD broadcasts.

Payload schema:

```json
{
  "reason": "task-status-changed",
  "sourceEvent": "invalidate",
  "taskId": "task-1",
  "taskIds": null,
  "status": "inprogress",
  "workspaceId": "workspace-1",
  "projectId": null,
  "patch": {
    "reason": "task-status-changed",
    "taskId": "task-1",
    "status": "inprogress"
  }
}
```

Emitter path:
- `server/ui-server.mjs` `broadcastUiEvent()`
- `infra/tui-bridge.mjs` `buildTasksUpdatePayload()`

## Current WS Audit

The current WS bridge in `server/ui-server.mjs` emits:

- `hello` - initial connection acknowledgement
- `subscribed` - channel subscription acknowledgement
- `pong` - heartbeat reply
- `session-message` - existing chat/session stream used by portal clients
- `monitor:stats` - canonical TUI stats snapshot
- `sessions:update` - canonical full session snapshot
- `session:event` - canonical per-session incremental event
- `logs:stream` - canonical structured log line
- `workflow:status` - canonical workflow state change
- `tasks:update` - canonical task diff event
- `workflow-run-events` - existing workflow timeline batch for portal UI
- `stats` - legacy portal/TUI aggregate event kept for compatibility
- `invalidate` and other portal-specific channel events used by existing portal tabs

## CI Validation

`tests/tui-events.test.mjs` validates the schema contract with Ajv.
`tests/ui-server-tui-events.test.mjs` validates live WS auth and canonical snapshot delivery.
`tests/workflow-engine.tui-status.test.mjs` validates workflow engine status emissions.
