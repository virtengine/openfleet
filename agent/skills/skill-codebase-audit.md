# Skill: Codebase Annotation Audit

## Purpose
Systematically audit and annotate a codebase so that *future* AI agents can
navigate it 4× faster, use 20% fewer tokens, and avoid false-positive changes.
This skill is **documentation-only** — it MUST NOT fix bugs, refactor code,
or change program behavior.

## Philosophy — LEAN Annotations

Modern AI coding SDKs (Copilot, Codex, Claude Code) already auto-compact
context. Adding a memory/compaction layer on top is wasteful. What *does* help
is **repo-level documentation** that agents read at the start of a session:
summaries, warnings, architectural notes, and module manifests. These cost zero
runtime tokens and dramatically reduce exploration time.

## Annotation Format

Use structured comment headers that agents are trained to recognize:

```
// CLAUDE:SUMMARY — <module-name>
// <1–3 sentence summary of purpose, key types, and public API>
```

```
// CLAUDE:WARN — <module-name>
// <non-obvious pitfall, race condition, or constraint agents MUST know>
```

- Place annotations at the **top of the file**, after imports / shebang.
- Keep each annotation to ≤ 3 lines.
- Do NOT annotate trivial files (configs, lockfiles, generated code).

## 6-Phase Audit

### Phase 1 — Inventory
Enumerate every source file. For each file record:
| Field | Value |
|-------|-------|
| path | relative from repo root |
| lang | file extension / language |
| lines | line count |
| has_summary | yes / no |
| has_warn | yes / no |
| category | core / util / test / config / generated |

Output: `.bosun/audit/inventory.json`

### Phase 2 — Summaries
For every file where `has_summary === false` and `category !== "generated"`:
1. Read the file.
2. Write a `CLAUDE:SUMMARY` comment at the top.
3. Stage the file.

### Phase 3 — Warnings
For every file, check for non-obvious constraints:
- Singleton/caching requirements (must be module-scope)
- Async fire-and-forget patterns (unhandled rejections)
- Order-dependent initialization
- Platform-specific behavior (Windows paths, etc.)

Add `CLAUDE:WARN` comments where found.

### Phase 4 — Manifest Audit
Ensure `AGENTS.md` (or equivalent) at repo root is accurate:
- Lists all top-level modules with 1-line descriptions.
- Documents build / test / lint commands.
- Documents environment variables.
- Documents commit conventions.
- Lists known constraints or gotchas.

If the file is outdated or missing sections, append corrections.

### Phase 5 — Conformity Check
Re-scan all annotations and validate:
- `CLAUDE:SUMMARY` is present in every non-trivial source file.
- `CLAUDE:WARN` exists for files with known pitfalls.
- No stale annotations reference symbols/functions that no longer exist.

Output: `.bosun/audit/conformity-report.json`

### Phase 6 — Regeneration Schedule
Annotations rot. Add a `.bosun/audit/schedule.json` with:
```json
{
  "lastFullAudit": "<ISO timestamp>",
  "nextRecommendedAudit": "<ISO timestamp + 30 days>",
  "filesAudited": <count>,
  "summariesAdded": <count>,
  "warningsAdded": <count>,
  "conformityScore": <0-100>
}
```

## Hard Rules

1. **Do NOT change program behavior.** Only add/update comments and documentation.
2. **Do NOT refactor, fix bugs, or rename symbols.** Documentation only.
3. **Do NOT annotate generated files** (lockfiles, build output, `.min.js`, etc.).
4. **Keep summaries ≤ 3 lines.** Agents need density, not essays.
5. **Keep warnings actionable.** "This is complex" is useless.
   "Must call init() before query() — throws otherwise" is helpful.
6. **Stage files individually** — never `git add .`.
7. **Commit with** `docs(audit): annotate <module>` — not `feat`/`fix`.

## Success Metrics
- A/B tested: annotated repos show 4× faster agent navigation.
- 20% fewer tokens consumed per task.
- Zero false-positive code changes from confused agents.

