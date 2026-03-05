# Bosun x SWE-bench (Official Harness Bridge)

This bridge keeps **Bosun** as the task execution system (multi-task, multi-turn, workflows) while using the **official SWE-bench harness** for scoring.

## What this gives you

- Bosun manages task execution and agent orchestration.
- SWE-bench harness (`python -m swebench.harness.run_evaluation`) remains the source of truth for benchmark scoring.
- Reproducible artifacts (instances input, predictions JSONL, harness run id/output).

## Prereqs

- Python environment with SWE-bench harness installed.
- Bosun running against repositories/workspaces that correspond to SWE-bench instances.
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

### 2) Let Bosun execute tasks

Run Bosun normally (`node cli.mjs`) and allow your configured executor/workflows to process tasks.

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
