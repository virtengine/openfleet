# Harness Surface Boundaries

Step 7 canonical surface owners:

- `server/routes/harness-sessions.mjs`
  - Owns session inspection and mutation semantics for `/api/harness/sessions/*`.
  - Owns transitional `/api/sessions/*` wrappers so web UI, TUI, and Telegram all resolve through one server module.
- `server/routes/harness-providers.mjs`
  - Owns provider inventory and SDK selection APIs for `/api/providers` and `/api/providers/sdk`.
  - Normalizes surface reads and writes for provider/session selection metadata.
- `server/routes/harness-approvals.mjs`
  - Owns harness approval listing and resolution APIs for `/api/harness/approvals/*` and `/api/harness/runs/:id/approval`.
- `server/routes/harness-events.mjs`
  - Owns live telemetry, replay/event queries, run inspection, run control, and harness artifact APIs.
  - `ui-server.mjs` delegates `/api/telemetry/harness/*`, `/api/harness/surface`, `/api/harness/runs/*`, `/api/harness/active`, `/api/harness/compile`, `/api/harness/activate`, and `/api/harness/run`.
- `server/routes/harness-subagents.mjs`
  - Owns subagent lineage and thread inspection APIs for `/api/harness/subagents/*` and `/api/harness/threads/*`.

Transitional compatibility boundaries kept intentionally in Step 7:

- `/api/sessions/*` remains the browser/TUI-friendly compatibility path, but `harness-sessions.mjs` is now the canonical server owner.
- `ui-server.mjs` remains the HTTP/WebSocket composition shell and dependency injector.
- Telegram uses `telegram/harness-api-client.mjs` against the canonical server APIs instead of importing `primary-agent.mjs` or `agent-pool.mjs`.

Explicit non-owners after this step:

- `telegram/telegram-bot.mjs` does not own provider, approval, or thread semantics.
- `tui/app.mjs` and `tui/screens/agents.mjs` do not own retry/provider/approval semantics; they render canonical snapshots and route mutations through shared API helpers.
- `ui/modules/agent-events.js` no longer falls back to the legacy agent-event REST surface when canonical harness telemetry is available.
