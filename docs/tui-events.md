# TUI WebSocket Event Contract

Bosun's terminal UI connects to the same local WebSocket server as the portal at `/ws`.
The TUI subscribes to a canonical set of real-time event types and should treat the
payloads below as the stable contract.

## Authentication

- The WebSocket server uses the same session token as the portal.
- The token can be sent as `Authorization: Bearer <token>` or as the `token` query
  parameter on `/ws`.
- Bosun persists a compatible plain-text token at `.bosun/.cache/ui-token`.
- The TUI may also read the token from `BOSUN_TUI_AUTH_TOKEN`, `BOSUN_TUI_WS_TOKEN`,
  `BOSUN_UI_TOKEN`, or `BOSUN_WS_TOKEN`.
- When the portal session token rotates, Bosun refreshes `.bosun/.cache/ui-token` so the
  TUI can reconnect without a portal-specific workaround.

Example URL:

```text
ws://127.0.0.1:3080/ws?token=<shared-ui-token>
```

## Existing WS Audit

The current WebSocket bus is centered in `server/ui-server.mjs`. `telegram/telegram-bot.mjs`
relies on that local UI server rather than maintaining a separate TUI-specific socket bus.
The audit below catalogs the emitted events relevant to the TUI bridge.

| Event | Payload shape | Emitter location |
| --- | --- | --- |
| `hello` | `{ connected: true }` handshake envelope | `server/ui-server.mjs` socket accept path |
| `subscribed` | `{ ok: true }` subscription ack | `server/ui-server.mjs` WS message handler |
| `pong` | ping/pong heartbeat envelope | `server/ui-server.mjs` WS message handler |
| `session-message` | legacy per-message payload from session tracker | `server/ui-server.mjs` → `broadcastSessionMessage()` |
| `sessions:update` | canonical full session snapshot array | `server/ui-server.mjs` → initial connect, `broadcastTuiSessionsSnapshot()`, message mirror, active-session listener |
| `session:event` | canonical incremental session payload | `server/ui-server.mjs` → `broadcastTuiSessionsSnapshot()` and `broadcastSessionMessage()` |
| `monitor:stats` | canonical monitor aggregate snapshot | `server/ui-server.mjs` → initial connect and `createTuiStatsEmitter()` |
| `stats` | legacy portal stats payload | `server/ui-server.mjs` stats emitter |
| `workflow-run-events` | legacy batched workflow run/node updates | `server/ui-server.mjs` → `queueWorkflowWsEvent()` |
| `workflow:status` | canonical workflow status payload | `workflow/workflow-engine.mjs` emits lifecycle events; `server/ui-server.mjs` bridges them in `attachWorkflowEngineLiveBridge()` |
| `log-lines` | legacy streamed raw log lines | `server/ui-server.mjs` → `startLogStream()` |
| `logs:stream` | canonical structured log line payload | `server/ui-server.mjs` → `startLogStream()` |
| `retry-queue-updated` / `invalidate` | legacy task and overview invalidation payloads | `server/ui-server.mjs` → `broadcastUiEvent()` |
| `tasks:update` | canonical task diff payload | `server/ui-server.mjs` → derived inside `broadcastUiEvent()` |

## Canonical Events

### `monitor:stats`

Emitted every 2 seconds with system-wide aggregate stats.

Payload fields:

- `activeAgents`
- `maxAgents`
- `tokensIn`
- `tokensOut`
- `tokensTotal`
- `throughputTps`
- `uptimeMs`
- `rateLimits` — map keyed by provider with `{ primary, secondary, credits, unit }`

Primary emitters:

- `server/ui-server.mjs` initial WS snapshot on connect
- `server/ui-server.mjs` periodic `createTuiStatsEmitter()` broadcast

### `sessions:update`

Emitted whenever session state changes. The payload is the full session snapshot array in
the same shape returned by the session tracker list API.

Typical triggers:

- agent session starts
- token counters update
- agent session ends
- session metadata changes
- active-session registry changes

Primary emitters:

- `infra/session-tracker.mjs` state listeners for start, update, end, status, rename
- `agent/agent-pool.mjs` active-session listener for steerable session lifecycle
- `server/ui-server.mjs` initial WS snapshot on connect

### `session:event`

Incremental per-session event stream.

Two common shapes:

- `event.kind = "message"` for streamed session messages
- `event.kind = "state"` for lifecycle changes such as start, refresh, usage, or end

Primary emitters:

- `server/ui-server.mjs` message mirror in `broadcastSessionMessage()`
- `server/ui-server.mjs` state mirror in `broadcastTuiSessionsSnapshot()`

### `logs:stream`

Structured log line event emitted while log streaming is active.

Payload fields:

- `logType`
- `query`
- `filePath`
- `line`
- `raw`
- `level`
- `timestamp`

Emitter location:

- `server/ui-server.mjs` → `startLogStream()`

### `workflow:status`

Workflow lifecycle event emitted by the workflow engine.

Emitted at minimum for:

- run start
- node complete
- run complete
- run error

Payload fields:

- `runId`
- `workflowId`
- `workflowName`
- `eventType`
- `status`
- `nodeId`
- `nodeType`
- `nodeLabel`
- `error`
- `durationMs`
- `timestamp`
- `meta`

Primary emitters:

- `workflow/workflow-engine.mjs` → `_emitWorkflowStatus()`
- `server/ui-server.mjs` → `attachWorkflowEngineLiveBridge()`

### `tasks:update`

Canonical task/kanban diff event. Bosun derives this from broader task invalidation and
task mutation broadcasts so the TUI can consume a stable payload shape.

Payload fields:

- `reason`
- `sourceEvent`
- `taskId`
- `taskIds`
- `status`
- `workspaceId`
- `projectId`
- `patch`

Emitter location:

- `server/ui-server.mjs` → `broadcastUiEvent()` task-channel derivation

## Notes

- Legacy UI events such as `stats`, `session-message`, `workflow-run-events`, and
  `log-lines` may still be present for portal compatibility.
- The TUI should prefer the six canonical event types documented here.
- CI validates the contract schemas with Ajv in `tests/tui-events.test.mjs`,
  `tests/tui-bridge.test.mjs`, and `tests/ui-server-tui-events.test.mjs`.
