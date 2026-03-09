<!-- tags: audit annotation documentation summary inventory codebase knowledge context skill warn manifest conformity regeneration claude -->
<!-- important: true -->
# Skill: Codebase Annotation Audit

## Purpose
Systematically annotate a repository so future agents start with `cat CLAUDE.md`
and `grep "CLAUDE:SUMMARY"` instead of rediscovering the codebase from scratch.
This skill is documentation-only and must never change runtime behavior.

## Hard Constraint
- Do not code, fix, refactor, rename, or optimize.
- Only add or refresh annotations, manifests, and audit artifacts.
- If a task requires behavior changes, stop and hand it back as out of scope.

## Annotation Contract
Use compact annotations agents can grep quickly:

```text
// CLAUDE:SUMMARY Routes the audit CLI and exposes scan, warn, and conformity flows.
// CLAUDE:WARN This module has startup side effects; preserve boot order when moving calls.
```

Rules:
- `CLAUDE:SUMMARY` is one sentence per file.
- `CLAUDE:WARN` is only for non-obvious hazards.
- Prefer top-of-file summaries and function-adjacent warnings.
- Do not annotate generated files, lockfiles, or obvious boilerplate.

## 6-Phase Audit Process

### Phase 1 — Inventory
Run `bosun audit scan` and review `.bosun/audit/inventory.json`.
Record language, line count, category, summary coverage, and warning coverage.

### Phase 2 — Summaries
Run `bosun audit generate` to add missing `CLAUDE:SUMMARY` lines.
Each summary should explain responsibility, not restate syntax.

### Phase 3 — Warnings
Run `bosun audit warn` and add `CLAUDE:WARN` only where agents would miss
side effects, lazy init, import cycles, or async fire-and-forget behavior.

### Phase 4 — Manifest Audit
Run `bosun audit manifest` and verify each directory has a lean `CLAUDE.md`
and generated `AGENTS.md` block that point agents to summaries before full reads.
Keep generated manifest sections compact and trim stale entries.

### Phase 5 — Conformity
Run `bosun audit conformity` to catch stale annotations, missing summaries,
missing warnings on risky files, and credential leaks before handoff.
Use `bosun audit --ci` in CI and `bosun audit conformity --staged --new-files-only --warn-only`
in pre-commit flows.

### Phase 6 — Regeneration
Run `bosun audit index` and `bosun audit trim` so `INDEX.map`, `CLAUDE.md`,
and generated `AGENTS.md` sections stay lean after file moves or rewrites.

## Quality Bar
- Start from manifests before opening full files.
- Prefer `grep "CLAUDE:SUMMARY"` over browsing.
- Keep summaries dense and warnings actionable.
- Migrate old `BOSUN:` markers with `bosun audit migrate`.
- Commit audit-only work as documentation changes, never as feature work.

## Success Signals
- First action is `cat CLAUDE.md` rather than globbing.
- Agents grep summaries before reading files.
- Fewer exploratory tokens and fewer false-positive edits.
- No sub-agents needed for repository discovery.
