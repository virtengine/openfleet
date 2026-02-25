# Bosun Workflows

Bosun workflows are DAGs (directed acyclic graphs) of nodes that automate orchestration tasks such as PR handling, anomaly response, task planning, and health checks. Workflows are editable in the Telegram miniapp UI and stored as JSON on disk.

**Where Workflows Live**
- Definitions: `.bosun/workflows/*.json`
- Run history index: `.bosun/workflow-runs/index.json`
- Full run logs: `.bosun/workflow-runs/<runId>.json`
- Migration state: `.bosun/workflow-migration.json`

**How To Create Or Install**
- UI: Telegram miniapp → Workflows tab → Create Workflow or install a template.
- API: `POST /api/workflows/save` to create or update JSON definitions.
- File-based: drop a workflow JSON file into `.bosun/workflows/`.
- Templates: `POST /api/workflows/install-template` or use the UI install button.

**Workflow Definition (JSON)**
Minimum example:
```json
{
  "name": "Hello Workflow",
  "description": "Logs a hello message",
  "category": "custom",
  "enabled": true,
  "nodes": [
    { "id": "trigger", "type": "trigger.manual", "label": "Manual", "config": {}, "position": { "x": 100, "y": 80 } },
    { "id": "log", "type": "notify.log", "label": "Log", "config": { "message": "Hello from workflow" }, "position": { "x": 100, "y": 220 } }
  ],
  "edges": [
    { "id": "trigger->log", "source": "trigger", "target": "log", "sourcePort": "default" }
  ],
  "variables": {}
}
```

Core fields:
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Optional for create; generated on save |
| `name` | string | Display name |
| `description` | string | Optional |
| `category` | string | Free-form grouping |
| `enabled` | boolean | Disabled workflows do not run |
| `trigger` | string | Optional summary for UI |
| `nodes` | array | Workflow nodes |
| `edges` | array | Connections between nodes |
| `variables` | object | Workflow-level defaults |
| `metadata` | object | Versioning, author, timestamps |

Node fields:
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique node ID |
| `type` | string | Node type from registry |
| `label` | string | UI label |
| `config` | object | Node-specific config |
| `position` | object | `{x,y}` for canvas layout |
| `outputs` | array | Named output ports |

Edge fields:
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique edge ID |
| `source` | string | Source node ID |
| `target` | string | Target node ID |
| `sourcePort` | string | Output port name |
| `condition` | string | Expression gate for the edge |

**Templating And Expressions**
- Template values inside config strings use `{{variable}}` syntax.
- You can reference node outputs in templates with `{{nodeId.field}}`.
- Edge conditions use JS expressions with `$output`, `$data`, `$status`, `$ctx`.

Example condition:
```js
$output?.success === true && $data?.priority === "high"
```

**Execution Model**
- Entry nodes are any nodes without incoming edges.
- Nodes run in parallel when dependencies are satisfied.
- Retries: `node.config.maxRetries` or `node.config.retryable = false` to disable.
- Error handling: `node.config.continueOnError = true` allows workflow to keep running.
- Run logs are persisted to `.bosun/workflow-runs/`.

**Built-in Node Types**
Triggers: `trigger.manual`, `trigger.task_low`, `trigger.schedule`, `trigger.event`, `trigger.webhook`, `trigger.pr_event`, `trigger.task_assigned`, `trigger.anomaly`, `trigger.scheduled_once`
Conditions: `condition.expression`, `condition.task_has_tag`, `condition.file_exists`, `condition.switch`
Actions: `action.run_agent`, `action.run_command`, `action.create_task`, `action.update_task_status`, `action.git_operations`, `action.create_pr`, `action.write_file`, `action.read_file`, `action.set_variable`, `action.delay`, `action.continue_session`, `action.restart_agent`, `action.bosun_cli`, `action.handle_rate_limit`, `action.ask_user`, `action.analyze_errors`, `action.refresh_worktree`
Validations: `validation.screenshot`, `validation.model_review`, `validation.tests`, `validation.build`, `validation.lint`
Transforms: `transform.json_parse`, `transform.template`, `transform.aggregate`
Notify: `notify.log`, `notify.telegram`, `notify.webhook_out`
Agent: `agent.select_profile`, `agent.run_planner`, `agent.evidence_collect`
Loop: `loop.for_each`

The authoritative list is exposed by `GET /api/workflows/node-types` and registered in `workflow-nodes.mjs`.

**Services And Requirements**
- `notify.telegram` requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Kanban actions require a configured kanban adapter and `VK_*` settings.
- `action.run_agent` and `action.continue_session` use the agent pool configured in the UI server.
- `action.run_command` executes on the host running `ui-server.mjs`.
- `action.ask_user` posts a question and stores `_pendingQuestion` in context for UI polling.

**Workflow API Endpoints**
- `GET /api/workflows` list workflows
- `GET /api/workflows/:id` full workflow definition
- `POST /api/workflows/save` create or update a workflow
- `DELETE /api/workflows/:id` delete a workflow
- `POST /api/workflows/:id/execute` run a workflow manually
- `GET /api/workflows/runs` list recent run summaries
- `GET /api/workflows/:id/runs` list run summaries for one workflow
- `GET /api/workflows/node-types` list registered node types
- `GET /api/workflows/templates` list templates
- `POST /api/workflows/install-template` install a template

**Run History Files**
- `index.json` contains a rolling list of recent run summaries.
- `<runId>.json` contains node outputs, logs, and errors for a single run.

**Workflow Migration Guard**
Bosun can migrate legacy modules into workflows with a safety guard.
- Config file: `.bosun/workflow-migration.json`
- Modes: `legacy`, `shadow`, `workflow`
- Implemented in `workflow-migration.mjs`

**Troubleshooting**
- No nodes in UI: verify `/api/workflows/:id` returns `workflow.nodes`.
- Runs show `0s`: durations under one second are rounded.
- No Telegram notifications: check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
