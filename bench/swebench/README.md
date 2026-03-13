# Bosun x SWE-bench (Official Harness Bridge)

This bridge keeps **Bosun** as the task execution system (multi-task, multi-turn, workflows) while using the **official SWE-bench harness** for scoring.

## What this gives you

- Bosun manages task execution and agent orchestration.
- SWE-bench harness (`python -m swebench.harness.run_evaluation`) remains the source of truth for benchmark scoring.
- Reproducible artifacts (instances input, predictions JSONL, harness run id/output).

## Prereqs

- Python environment with SWE-bench harness installed.
- Bosun running against repositories/workspaces that correspond to SWE-bench instances.
- Bosun using the **internal kanban backend** (`KANBAN_BACKEND=internal`, which is the default). This bridge imports tasks into Bosun's internal task store; other kanban backends will not see those imported tasks unless you build a separate sync path.
- `import` now writes each task into the workspace repo's own internal store at `<workspace>/.bosun/.cache/kanban-state.json`, so the benchmark repo and monitor share the same task state without manually setting `BOSUN_STORE_PATH`.
- Instance input JSONL with at least:
  - `instance_id`
  - `problem_statement`
  - `base_commit`
  - `workspace` (or `repo_path`) pointing to the local checked-out repo for that instance

## Commands

### 1) Import SWE-bench instances into Bosun tasks

```bash
node bench/swebench/bosun-swebench.mjs import --instances ./bench/swebench/instances.jsonl --status todo --priority high --candidates 3
```

`--candidates N` enables Bosun's native multi-candidate + selector workflow path for imported tasks.
You can also set per-instance `candidate_count` inside `instances.jsonl`.
By default, import also seeds the target workspace repo with Bosun's `template-task-lifecycle`
workflow under `.bosun/workflows` and applies `maxParallel: 1` so the benchmark runtime
can dispatch immediately without manual workflow installation. Pass `--no-ensure-runtime`
to opt out of that provisioning step.

### 2) Let Bosun execute tasks

Run Bosun normally (`node cli.mjs`) and allow your configured executor/workflows to process tasks.

Important execution details:

- Imported SWE-bench tasks are stored as regular Bosun tasks tagged with `swebench` and `benchmark`.
- The monitor now loads workflow definitions and workflow-run state from the selected benchmark repo root (`<repo>/.bosun/workflows` and `<repo>/.bosun/workflow-runs`), so `--repo-root` and per-instance workspaces point at the same runtime state.
- On the default workflow-first lifecycle, Bosun will still apply its normal task machinery (executor resolution, workflow prompts, relevant skills, tool-discovery guidance, candidate-count handling, and context management).
- If you want a dedicated SWE-bench execution path, create an enabled agent workflow that replaces `primary-agent.mjs` and match SWE-bench tasks with `trigger.task_assigned` filtering such as `task.tags?.includes('swebench')`.
- This bridge still does **not** ship a dedicated SWEBench-specific workflow/template or a CLI flag that pins benchmark tasks to a custom benchmark workflow. It provisions the standard lifecycle template and otherwise uses whatever Bosun task/workflow setup is active in that repo.

### 3) Export predictions in official schema

```bash
node bench/swebench/bosun-swebench.mjs export --out ./bench/swebench/predictions.jsonl --model bosun-codex
```

Output format per line:

- `instance_id`
- `model_name_or_path`
- `model_patch`

### 4) Evaluate with official SWE-bench harness

```bash
node bench/swebench/bosun-swebench.mjs eval --predictions ./bench/swebench/predictions.jsonl --instance-ids ./bench/swebench/instance_ids.jsonl --run-id bosun-baseline --max-workers 8
```

This executes:

```bash
python -m swebench.harness.run_evaluation ...
```

And writes a reproducibility manifest at:

`bench/swebench/runs/<run_id>/manifest.json`

## Reproducibility recommendations

- Pin Bosun commit SHA and model version.
- Keep all run inputs versioned (`instances.jsonl`, prompts/config, model routing config).
- Store full artifacts under a run folder (`run_id`, predictions, harness output logs).
- Re-run the same run id/config multiple times to track variance.

## Current scope

This bridge is intentionally narrow:

- It fixes import/export/eval compatibility with the official SWE-bench harness.
- It allows Bosun's existing execution stack to operate on imported SWE-bench tasks and now provisions the baseline lifecycle workflow runtime needed for those tasks to dispatch.
- It does **not** by itself prove that every Bosun capability or optimization is exercised. If you need a benchmark path that explicitly pins custom workflows, prompt libraries, skills, or agent profiles, build and version that workflow/config as part of the benchmark setup.
