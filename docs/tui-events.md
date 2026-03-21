# TUI WebSocket events

This file documents the current WebSocket bus in `server/ui-server.mjs` and the stable event contract the TUI should consume.

## Transport

- Endpoint: `/ws`
- Standard server envelope:

```json
{ "type": "monitor:stats", "channels": ["stats", "tui"], "payload": {}, "ts": 1742553600000 }
```

Most pushed events use that envelope. Control/response messages such as `ping`, `pong`, and `voice-tool-result` are not part of the canonical TUI contract.

## Current emitted events

`telegram/telegram-bot.mjs` does not emit WebSocket frames directly. It only builds browser URLs with the shared UI token from `server/ui-server.mjs`.

### General UI bus

| Event | Payload | Emitter |
|---|---|---|
| `hello` | `{ connected: true }` | WS connection open |
| `subscribed` | `{ ok: true }` | `subscribe` request ack |
| `ping` / `pong` | `{ ts }` | Heartbeat / ping reply |
| `invalidate` | Usually `{ reason, ... }` | `broadcastUiEvent()` |
| `session-message` | Session message payload | `broadcastSessionMessage()` |
| `stats` | Same payload as `monitor:stats` | Periodic stats ticker |
| `retry-queue-updated` | Retry queue snapshot | `setRetryQueueData()` |
| `workflow-run-events` | `{ workflowId, runId, events[] }` | `queueWorkflowWsEvent()` |
| `log-lines` | `{ lines: string[] }` | Log tailer |
| `voice-tool-result` | `{ callId, ...result }` or `{ callId, error }` | Voice tool call handler |

### Canonical TUI contract

Only these six events are stable TUI inputs:

| Event | Channels | Emitter | Payload source |
|---|---|---|---|
| `monitor:stats` | `stats`, `tui` | Initial WS hello path + 2s interval | `buildMonitorStats()` |
| `sessions:update` | `sessions`, `tui` | Session state listener + initial connect snapshot | `buildSessionsUpdatePayload()` |
| `session:event` | `sessions`, `tui` | Session event listener | `buildSessionEventPayload()` |
| `logs:stream` | `logs`, `tui` | `subscribe-logs` log tail stream | `buildStructuredLogLine()` |
| `workflow:status` | `workflows`, `tui` | Workflow engine live bridge for `run:start`, `node:complete`, `run:end`, `run:error` | `buildWorkflowStatusPayload()` |
| `tasks:update` | `tasks`, `tui` | Task invalidation bridge | `buildTaskUpdatePayload()` |

The authoritative schemas live in `infra/tui-bridge.mjs` as `TUI_EVENT_SCHEMAS` and are validated in CI with `ajv`.

## Payload summaries

### `monitor:stats`

```json
{
  "activeAgents": 2,
  "maxAgents": 6,
  "tokensIn": 520,
  "tokensOut": 130,
  "tokensTotal": 650,
  "throughputTps": 325,
  "uptimeMs": 2000,
  "rateLimits": { "openai": { "primary": 12, "secondary": 0, "credits": 1000, "unit": "rpm" } },
  "ts": 1742553600000
}
```

Emitted immediately on connect, then every 2 seconds.

### `sessions:update`

Full array snapshot matching `infra/session-tracker.mjs#listAllSessions()`.

### `session:event`

Incremental per-session event with `sessionId`, `taskId`, `message`, `session`, and `ts`.

### `logs:stream`

Structured log line with `logType`, `source`, `level`, `message`, `raw`, `timestamp`, `parsed`, and `ts`.

### `workflow:status`

Workflow milestone event emitted for `run:start`, `node:complete`, `run:end`, and `run:error`.

### `tasks:update`

Task/kanban diff-style update derived from task invalidation events.

## Auth flow

The TUI uses the same auth token as the portal/browser client.

Token resolution order:

1. `BOSUN_UI_TOKEN`
2. `BOSUN_UI_SESSION_TOKEN`
3. `.bosun/.cache/ui-token`
4. `.bosun/.cache/ui-session-token.json`
5. Generate a new 64-hex token and persist it

Recommended local connection:

```text
ws://127.0.0.1:<port>/ws?token=<ui-token>
```

Alternative auth paths also supported by the server: `Authorization: Bearer <BOSUN_API_KEY>`, desktop API key, or Telegram `initData`. For the TUI, prefer the shared UI session token because it matches the token already appended to browser URLs by `telegram/telegram-bot.mjs`.

Optional narrowed subscription:

```json
{ "type": "subscribe", "channels": ["tui", "stats", "sessions", "tasks", "workflows", "logs"] }
```

## Verification

- Connect a raw client to `/ws?token=<ui-token>` and confirm `monitor:stats` arrives every 2 seconds.
- Start and end a session and confirm `sessions:update` reflects the before/after snapshot.
- Run `subscribe-logs` and confirm `logs:stream` emits structured lines.
- Run a workflow and confirm `workflow:status` emits `run:start`, `node:complete`, `run:end`, or `run:error`.
