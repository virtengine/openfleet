# GitHub Projects v2 Integration - Implementation Checklist

**Status**: ✅ Phase 1, 2, and 3 implementation complete (manual GitHub validation pending token scope + code review)  
**Started**: 2026-02-15  
**Completed**: 2026-02-16

---

## Phase 1: Read Support (Non-Breaking)

### Core Methods

- [x] **`getProjectNodeId(projectNumber)`**
  - [x] Implement GraphQL query for organization projects
  - [x] Implement GraphQL query for user projects
  - [x] Add session-lifetime caching (Map)
  - [x] Error handling for invalid project numbers
  - [x] Unit test with mocked gh CLI

- [x] **`getProjectFields(projectNumber)`**
  - [x] Call `gh project field-list` with JSON format
  - [x] Parse response and build field lookup map
  - [x] Cache results (Map: projectNumber → fieldMap)
  - [x] Extract Status field with options
  - [x] Extract Iteration field with iterations
  - [x] Unit test with sample field metadata

- [x] **`listTasksFromProject(projectNumber)`**
  - [x] Call `gh project item-list` with JSON format
  - [x] Filter for Issue type items (skip PRs if needed)
  - [x] Map to `KanbanTask` format via `_normaliseProjectItem()`
  - [x] Apply task label filter if `_enforceTaskLabel` enabled
  - [x] Error handling for empty/invalid responses
  - [x] Unit test with sample project items

- [x] **`_getProjectItemIdForIssue(projectNumber, issueNumber)`**
  - [x] GraphQL resource query to find project item
  - [x] Find item matching project node ID
  - [x] Extract and return `projectItemId`
  - [x] Cache result (Map: "projectNum:issueNum" → itemId)
  - [x] Return null if not found
  - [x] Unit test with cached and uncached lookups

### Helper Methods

- [x] **`_normaliseProjectItem(projectItem)`**
  - [x] Extract issue number from `content.number`
  - [x] Extract issue number from URL as fallback
  - [x] Map project Status to codex status (via `_normalizeProjectStatus()`)
  - [x] Extract assignees, labels from content
  - [x] Build `meta.codex` flags from labels
  - [x] Return KanbanTask object
  - [x] Unit test with various project item formats

- [x] **`_normalizeProjectStatus(projectStatusName)`**
  - [x] Map project status names to codex statuses (bidirectional)
  - [x] Support common variations (case-insensitive)
  - [x] Default to "todo" for unknown statuses
  - [x] Unit test all status mappings

### Integration with Existing Code

- [x] **Update `listTasks(_projectId, filters = {})`**
  - [x] Check if `this._projectMode === "kanban"`
  - [x] Check if `this._cachedProjectNumber` exists
  - [x] If both true, call `listTasksFromProject()` instead of repo issues
  - [x] Otherwise, use existing `gh issue list` implementation
  - [x] Integration test: verify mode switching works

### Caching Infrastructure

- [x] **Add cache properties to GitHubAdapter**
  - [x] `_projectNodeIdCache = new Map()`
  - [x] `_projectFieldsCache = new Map()`
  - [x] `_projectItemCache = new Map()`
  - [x] Document cache lifetime (session-scoped)

### Testing

- [x] **Unit tests** (`tests/kanban-github-projects.test.mjs`)
  - [x] `getProjectNodeId()` - mocked GraphQL response
  - [x] `getProjectFields()` - mocked field list
  - [x] `listTasksFromProject()` - mocked item list
  - [x] `_normaliseProjectItem()` - various formats
  - [x] Status mapping - all codex statuses
  - [x] Caching behavior - verify cache hits/misses

- [x] **Integration tests**
  - [x] List tasks in "issues" mode (existing behavior)
  - [x] List tasks in "kanban" mode (new behavior)
  - [x] Verify task metadata includes project fields
  - [x] Verify fallback when project unavailable

- [ ] **Manual testing**
  - [ ] Set up test project with sample issues
  - [ ] Run `listTasks()` and inspect output
  - [ ] Verify all fields map correctly
  - [ ] Test with empty project
  - [ ] Test with invalid project number
  - Blocked: `gh project` commands currently fail with `missing required scopes [read:project]` in this environment.

---

## Phase 2: Write Support (Bidirectional Sync)

### Core Methods

- [x] **`syncStatusToProject(issueNumber, projectNumber, status)`**
  - [x] Get project node ID via `getProjectNodeId()`
  - [x] Get Status field metadata via `getProjectFields()`
  - [x] Map codex status to project option name (use env vars)
  - [x] Find option ID for mapped status name
  - [x] Get project item ID via `_getProjectItemIdForIssue()`
  - [x] Build GraphQL mutation for `updateProjectV2ItemFieldValue`
  - [x] Execute mutation via `gh api graphql`
  - [x] Return true on success, false on failure
  - [x] Log warnings for missing fields/items
  - [x] Unit test with mocked mutations

- [x] **`syncFieldToProject(issueNumber, projectNumber, fieldName, value)`**
  - [x] Generic field update supporting text, number, date, single_select
  - [x] Get field metadata and determine type
  - [x] Build appropriate value object based on type
  - [x] Execute GraphQL mutation
  - [x] Unit test with all field types

- [x] **`syncIterationToProject(issueNumber, projectNumber, iterationName)`** (Optional)
  - [x] Get Iteration field metadata
  - [x] Find iteration by name or startDate
  - [x] Build mutation with iterationId
  - [x] Execute GraphQL mutation
  - [x] Unit test with sample iterations

### Integration with Existing Code

- [x] **Update `updateTaskStatus(issueNumber, status, options = {})`**
  - [x] After updating issue labels (existing code)
  - [x] Check if `this._projectMode === "kanban"`
  - [x] Check if `this._cachedProjectNumber` exists
  - [x] Check if `GITHUB_PROJECT_AUTO_SYNC !== "false"`
  - [x] If all true, call `syncStatusToProject()`
  - [x] Continue with shared state handling (existing code)
  - [x] Integration test: verify status sync works

### Status Mapping Configuration

- [x] **Environment variables** (`.env.example`)
  - [x] `GITHUB_PROJECT_STATUS_TODO=Todo`
  - [x] `GITHUB_PROJECT_STATUS_INPROGRESS=In Progress`
  - [x] `GITHUB_PROJECT_STATUS_INREVIEW=In Review`
  - [x] `GITHUB_PROJECT_STATUS_DONE=Done`
  - [x] `GITHUB_PROJECT_STATUS_CANCELLED=Cancelled`
  - [x] `GITHUB_PROJECT_AUTO_SYNC=true`

- [x] **Config schema** (`openfleet.schema.json`)
  - [x] Add `kanban.github.project` section
  - [x] Add `statusMapping` object
  - [x] Add `autoSync` boolean

### Error Handling & Resilience

- [x] **Rate limit handling**
  - [x] Detect rate limit errors in `_gh()`
  - [x] Implement backoff (configurable delay, default 60s)
  - [x] Retry once, then fail gracefully
  - [x] Log rate limit hits

- [x] **Graceful degradation**
  - [x] Missing project: log warning, skip sync
  - [x] Missing Status field: log warning, skip sync
  - [x] Item not in project: log warning, skip sync
  - [x] Invalid option mapping: log warning, skip sync

### Testing

- [x] **Unit tests**
  - [x] `syncFieldToProject()` - all field types (SINGLE_SELECT, NUMBER, DATE, TEXT)
  - [x] Status mapping with custom env vars
  - [x] Error handling for missing fields/items
  - [x] Rate limit handling (retry, double-fail, non-rate-limit)

- [x] **Integration tests**
  - [x] Update status → verify project field updates
  - [x] Auto-sync toggle (enable/disable via env var)
  - [x] Error recovery scenarios

- [ ] **Manual testing**
  - [ ] Update task status via openfleet
  - [ ] Check project board for updated Status column
  - [ ] Test all status transitions
  - [ ] Test with custom status mappings
  - Blocked: `gh project` commands currently fail with `missing required scopes [read:project]` in this environment.

---

## Phase 3: Advanced Features (Optional)

### Project View Filtering

- [x] Filter tasks by project field values
- [x] Support `filters.projectField` parameter
- [x] Query project items with field conditions

### Batch Operations

- [x] Batch status updates (reduce API calls)
- [x] Batch field updates
- [x] Use GraphQL aliases for parallel mutations

### Webhook Integration

- [x] GitHub webhook for project item updates
- [x] Real-time sync without polling
- [x] Requires GitHub App or webhook setup

### Draft Issues

- [x] Create draft issues in project
- [x] Convert drafts to real issues
- [x] Use `addProjectV2DraftIssue` mutation

---

## Documentation

- [x] **Main API guide** (`GITHUB_PROJECTS_V2_API.md`)
  - [x] Current state analysis
  - [x] API overview with examples
  - [x] Implementation plan with code
  - [x] Configuration guide
  - [x] Testing strategy
  - [x] Migration guide

- [x] **Quick start guide** (`GITHUB_PROJECTS_V2_QUICKSTART.md`)
  - [x] TL;DR summary
  - [x] Essential commands
  - [x] Implementation checklist
  - [x] Testing commands

- [x] **Research summary** (`GITHUB_PROJECTS_V2_RESEARCH_SUMMARY.md`)
  - [x] Problem statement
  - [x] Research findings
  - [x] Implementation phases
  - [x] Success criteria

- [x] **Update existing docs**
  - [x] `KANBAN_GITHUB_ENHANCEMENT.md` - Add Projects v2 note
  - [x] `GITHUB_ADAPTER_QUICK_REF.md` - Add Projects v2 links
  - [x] `README.md` - Add Projects v2 section (if applicable)

---

## Deployment

### Configuration Updates

- [x] Update `.env.example` with new variables
- [x] Update `openfleet.schema.json` with project config
- [x] Document migration steps in `GITHUB_PROJECTS_V2_API.md`

### Release Notes

- [x] Document Phase 1 features (read support)
- [x] Document Phase 2 features (sync support)
- [x] Provide migration guide for existing users
- [x] Highlight backward compatibility

### Monitoring

- [x] Add logging for project operations
- [x] Track sync success/failure rates
- [x] Monitor API rate limit usage
- [x] Alert on sync failures

---

## Sign-off Criteria

### Phase 1 Ready for Merge When:

- [x] All Phase 1 checkboxes above are complete
- [x] Unit tests pass with >80% coverage
- [x] Integration tests pass
- [ ] Manual testing confirms functionality
- [ ] Code review approved
- [x] Documentation reviewed

### Phase 2 Ready for Merge When:

- [x] All Phase 2 checkboxes above are complete
- [x] All Phase 1 items still passing
- [x] Unit tests pass with >80% coverage
- [x] Integration tests include sync scenarios
- [ ] Manual testing confirms bidirectional sync
- [ ] Code review approved
- [x] Documentation updated

### Phase 3 Ready for Merge When:

- [x] Feature-specific criteria defined
- [x] All tests passing
- [x] Documentation complete
- [ ] Code review approved

---

## Progress Tracking

**Phase 1**: ✅ Complete (100%) — manual testing blocked by missing `read:project` token scope  
**Phase 2**: ✅ Complete (100%) — manual testing blocked by missing `read:project` token scope  
**Phase 3**: ✅ Complete (100%) — implementation, tests, and docs complete

**Last Updated**: 2026-02-17  
**Next Review**: Manual GitHub project validation + code review

---

## Notes

- This checklist is a living document - update as implementation progresses
- Mark items complete with `[x]` when finished
- Add notes/blockers inline as needed
- Update progress percentages weekly
