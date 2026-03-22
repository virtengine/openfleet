# WORKFLOW.md Contract

`WORKFLOW.md` is an optional project-root markdown file that Bosun reads at session start. When present, the task lifecycle workflow loads it, validates required fields, records it in the workflow context log, and injects the full document into the agent prompt before any coding begins.

## Required fields

- `terminalStates` — list of terminal task/session states the project considers complete.
- `forbiddenPatterns` — list of forbidden shell commands, command fragments, or action patterns the agent must avoid.

## Optional fields

- `projectDescription` — short project summary.
- `preferredTools` — tools/commands the agent should prefer.
- `preferredModel` — preferred reasoning model for the task.
- `rules` — additional project-specific guardrails.
- `escalationContact` — person, team, or channel to contact when blocked.
- `escalationPaths` — explicit escalation routes.

## Format

The file can contain normal markdown prose plus a lightweight YAML-style contract block. Bosun scans the markdown for known keys, so the contract can live inline in the document.

## Example

```md
# Payments API Workflow Contract

This service handles card authorization and settlement flows. Prefer low-risk changes, keep migrations reversible, and escalate quickly for any production-data uncertainty.

projectDescription: PCI-adjacent payments API with strict release controls
terminalStates:
  - done
  - accepted
forbiddenPatterns:
  - git push --force
  - rm -rf /
  - npm test -- --watch
preferredTools:
  - rg
  - npm test -- tests/payments/*.test.mjs
  - npm run build
preferredModel: gpt-5
rules:
  - Keep schema changes backward compatible.
  - Do not rotate credentials from automation.
escalationContact: '#payments-oncall'
escalationPaths:
  - Slack #payments-oncall
  - PagerDuty service: payments-primary
```

## Runtime behavior

1. `read-workflow-contract` loads `WORKFLOW.md` from the project root if it exists.
2. `workflow-contract-validation` fails fast when required fields are missing.
3. `action.build_task_prompt` appends the full contract to the session prompt.
4. The workflow run log records the load event so prompt assembly is debuggable.

## Validation failures

If `WORKFLOW.md` exists but omits `terminalStates` or `forbiddenPatterns`, the session-start workflow stops before agent execution and returns a descriptive validation error.
