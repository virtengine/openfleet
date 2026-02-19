# Changelog Entry - GitHub Projects v2 + GitHub Adapter Enhancements

## [Unreleased]

### Added - GitHub Projects v2 Integration (Phase 1 + Phase 2)

#### Phase 1 (Read Support)

- Added project-board task listing in GitHub adapter via `GITHUB_PROJECT_MODE=kanban`
- Added project item normalization to `KanbanTask` format (no per-item N+1 issue fetches)
- Added project metadata caching:
  - project node IDs
  - project field metadata
  - issue-to-project-item IDs
- Added automatic fallback to issue listing when project reads fail

#### Phase 2 (Write Support)

- Added status sync from codex task updates to GitHub Projects v2 `Status` field
- Added generic project field sync helper (`syncFieldToProject`) for:
  - single select
  - number
  - date
  - text
- Added configurable status mapping through `GITHUB_PROJECT_STATUS_*` environment variables
- Added `GITHUB_PROJECT_AUTO_SYNC` toggle for write synchronization control
- Added rate-limit retry handling for `gh` GraphQL operations

#### Migration Guidance

- Existing users can stay on default behavior (`GITHUB_PROJECT_MODE=issues`)
- To enable Projects v2:
  - set `KANBAN_BACKEND=github`
  - set `GITHUB_PROJECT_MODE=kanban`
  - configure `GITHUB_PROJECT_OWNER` + `GITHUB_PROJECT_NUMBER`
  - optionally customize `GITHUB_PROJECT_STATUS_*` mappings
- Full migration details are documented in:
  - `GITHUB_PROJECTS_V2_API.md`
  - `GITHUB_PROJECTS_V2_QUICKSTART.md`

#### Monitoring Documentation

- Added `GITHUB_PROJECTS_V2_MONITORING.md` with:
  - operational log signals
  - failure/success log patterns
  - rate-limit monitoring guidance
  - alert recommendations

### Added - GitHub Issues Shared State Enhancements

- `persistSharedStateToIssue(issueNumber, sharedState)`
- `readSharedStateFromIssue(issueNumber)`
- `markTaskIgnored(issueNumber, reason)`
- `meta.codex` task flags for claim/ignore/stale visibility

### Updated - Jira Configuration and Docs Parity

- Added concrete Jira env examples for status mapping (`JIRA_STATUS_*`)
- Added concrete Jira env examples for shared-state custom fields (`JIRA_CUSTOM_FIELD_*`)
- Added Jira shared-state label env examples (`JIRA_LABEL_*`)
- Updated `.env.example`, `openfleet.schema.json`, `README.md`, and `JIRA_INTEGRATION.md` for consistent Jira parity documentation

### Backward Compatibility

- Breaking changes: none
- Default issue-based behavior is unchanged
- Projects v2 path is opt-in (`GITHUB_PROJECT_MODE=kanban`)
- VK and Jira adapters are unaffected

### Dependencies

- GitHub CLI (`gh`) with `project` scope for Projects v2 operations
