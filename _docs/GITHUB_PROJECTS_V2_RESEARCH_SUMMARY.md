# GitHub Projects v2 Integration - Research Summary

**Created**: 2026-02-15  
**Status**: Research & Documentation Complete  
**Next**: Implementation (Phases 1-3)

---

## Problem Statement

The current GitHubAdapter in `kanban-adapter.mjs` only **adds issues to projects** via `gh project item-add`. It does NOT:

❌ Read tasks FROM project boards  
❌ Sync status updates TO project fields (Status column)  
❌ Read/write custom project fields  
❌ Update iteration/sprint fields  
❌ Manage project item metadata

This limits openfleet's ability to work with GitHub Projects v2 as a primary task board.

---

## Research Findings

### API Architecture

**GitHub Projects v2 uses GraphQL exclusively** - no REST API support.

**Two access patterns**:

1. **High-level CLI**: `gh project item-list`, `gh project field-list` (recommended for reads)
2. **Low-level GraphQL**: `gh api graphql -f query='...'` (required for mutations)

**Critical concept**: Projects v2 requires **node IDs** (not numbers) for all operations:

- Project: `PVT_kwDOABCDEF` (resolved from project number)
- Item: `PVTI_lADOABC123` (when adding/listing items)
- Field: `PVTF_lADOXYZ456` (from field list)
- Option: `f75ad846` (for Status: "In Progress" → option ID)

### Key Commands Documented

```bash
# Get project ID
gh api graphql -f query='
  query {
    organization(login: "virtengine") {
      projectV2(number: 3) { id title }
    }
  }
'

# List items (easiest read method)
gh project item-list 3 --owner virtengine --format json

# List fields and options (required for updates)
gh project field-list 3 --owner virtengine --format json

# Update Status field (GraphQL mutation required)
gh api graphql -f query='
  mutation {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: "PVT_xxx"
        itemId: "PVTI_xxx"
        fieldId: "PVTF_xxx"
        value: { singleSelectOptionId: "option_id" }
      }
    ) { projectV2Item { id } }
  }
'
```

### Current Code

**File**: `scripts/openfleet/kanban-adapter.mjs`  
**Lines**: 1125-1154  
**Method**: `_ensureIssueLinkedToProject(issueUrl)`

**What it does**:

```javascript
await this._gh(
  [
    "project",
    "item-add",
    String(projectNumber),
    "--owner",
    owner,
    "--url",
    issueUrl,
  ],
  { parseJson: false },
);
```

**Limitation**: One-way only (issue → project). No status sync, no field updates, no reading.

---

## Documentation Created

### 1. [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md)

**Comprehensive 28KB guide covering**:

- ✅ Current state analysis with code references
- ✅ What's missing (5 major gaps)
- ✅ API overview (GraphQL patterns, node IDs, authentication)
- ✅ Reading project data (3 query types with examples)
- ✅ Writing project data (3 mutation types with examples)
- ✅ Implementation plan (3 phases with method signatures)
- ✅ Configuration updates (env vars, config schema)
- ✅ Helper methods with complete code examples
- ✅ Testing plan (unit, integration, manual)
- ✅ Migration guide (backward compatible)
- ✅ Performance considerations (caching, rate limits)
- ✅ Appendix with full code example

**Target audience**: Implementers who need every detail

### 2. [GITHUB_PROJECTS_V2_QUICKSTART.md](./GITHUB_PROJECTS_V2_QUICKSTART.md)

**TL;DR 5KB guide covering**:

- ✅ Current gap summary
- ✅ Key concepts (GraphQL, node IDs)
- ✅ Essential commands only
- ✅ Implementation checklist (checkbox format)
- ✅ Configuration example
- ✅ Code patterns (read + write)
- ✅ Testing commands
- ✅ Performance tips
- ✅ Migration steps

**Target audience**: Quick reference during implementation

### 3. Cross-References Added

**Updated files**:

- `KANBAN_GITHUB_ENHANCEMENT.md` - Added note pointing to Projects v2 docs
- `GITHUB_ADAPTER_QUICK_REF.md` - Added header with Projects v2 links

---

## Implementation Plan

### Phase 1: Read Support (Non-Breaking)

**Goal**: Read tasks from project boards without changing existing behavior.

**Methods to add**:

```javascript
async getProjectNodeId(projectNumber)
async getProjectFields(projectNumber)
async listTasksFromProject(projectNumber)
async _getProjectItemIdForIssue(projectNumber, issueNumber)
```

**Update existing**:

```javascript
async listTasks(_projectId, filters = {}) {
  // If mode=kanban, read from project instead of repo issues
  if (this._projectMode === "kanban" && this._cachedProjectNumber) {
    return this.listTasksFromProject(this._cachedProjectNumber);
  }
  // ... existing implementation ...
}
```

**Caching strategy**:

- Project node IDs: Session lifetime
- Field metadata: Session lifetime
- Item ID lookups: Session lifetime
- Clear on restart or project change

**Estimated complexity**: Medium (4-5 methods, ~200 LOC)

### Phase 2: Write Support (Bidirectional Sync)

**Goal**: Sync status updates TO project Status field.

**Methods to add**:

```javascript
async syncStatusToProject(issueNumber, projectNumber, status)
async syncFieldToProject(issueNumber, projectNumber, fieldName, value)
async syncIterationToProject(issueNumber, projectNumber, iterationName)
```

**Update existing**:

```javascript
async updateTaskStatus(issueNumber, status, options = {}) {
  // ... existing issue label updates ...

  // NEW: Sync to project if configured
  if (this._projectMode === "kanban" && this._cachedProjectNumber) {
    await this.syncStatusToProject(
      issueNumber,
      this._cachedProjectNumber,
      status
    );
  }

  // ... existing shared state handling ...
}
```

**Status mapping**:

```javascript
const STATUS_TO_PROJECT_OPTION = {
  todo: "Todo",
  inprogress: "In Progress",
  inreview: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};
```

**Configuration**:

```bash
GITHUB_PROJECT_MODE=kanban  # Enable sync
GITHUB_PROJECT_OWNER=virtengine
GITHUB_PROJECT_NUMBER=3
GITHUB_PROJECT_AUTO_SYNC=true  # Auto-sync on status change
```

**Estimated complexity**: Medium (3 methods, ~150 LOC)

### Phase 3: Advanced Features (Optional)

**Potential enhancements**:

- Project view filtering (by field values)
- Batch operations (bulk updates)
- Webhook integration (real-time sync)
- Draft issue support
- Iteration planning integration

**Estimated complexity**: High (varies by feature)

---

## Testing Strategy

### Unit Tests

**New test file**: `tests/kanban-github-projects.test.mjs`

```javascript
describe("GitHub Projects v2 Integration", () => {
  test("getProjectNodeId() resolves project number to node ID", async () => {
    // Mock gh CLI response
    // Verify ID extraction and caching
  });

  test("getProjectFields() returns field metadata with caching", async () => {
    // Mock gh CLI response
    // Verify field lookup map structure
  });

  test("listTasksFromProject() normalizes items to KanbanTask format", async () => {
    // Mock gh CLI response
    // Verify status mapping, field extraction
  });

  test("syncStatusToProject() updates Status field correctly", async () => {
    // Mock GraphQL mutation
    // Verify correct IDs and option mapping
  });

  test("status mapping handles all codex statuses", () => {
    // Test todo, inprogress, inreview, done, cancelled
  });
});
```

### Integration Tests

**Test scenarios**:

1. Create issue → Auto-add to project (existing, verify still works)
2. Update status → Verify project Status field updates
3. Read from project → Verify `listTasks()` returns project items
4. Missing item → Handle gracefully (log warning, continue)
5. Missing field → Handle gracefully (log warning, skip sync)

### Manual Testing

```bash
# Setup test environment
cd scripts/openfleet
export KANBAN_BACKEND=github
export GITHUB_PROJECT_MODE=kanban
export GITHUB_PROJECT_OWNER=virtengine
export GITHUB_PROJECT_NUMBER=3

# Test 1: List tasks from project
node -e "
  import('./kanban-adapter.mjs').then(async ({ listTasks }) => {
    const tasks = await listTasks('virtengine/virtengine');
    console.log('Tasks from project:', tasks.length);
    console.log('Sample task:', JSON.stringify(tasks[0], null, 2));
  });
"

# Test 2: Update status and verify sync
node -e "
  import('./kanban-adapter.mjs').then(async ({ updateTaskStatus, getTask }) => {
    await updateTaskStatus('123', 'inprogress');
    const task = await getTask('123');
    console.log('Updated task status:', task.status);
    console.log('Project fields:', task.meta.projectFields);
  });
"

# Test 3: Verify project board manually
gh project item-list 3 --owner virtengine --format json | jq '.[] | select(.content.number == 123)'
```

---

## Performance Considerations

### Caching Requirements

**Must cache** (session lifetime):

- ✅ Project node ID (from project number) - Rarely changes
- ✅ Project field metadata (IDs, options, iterations) - Static per project
- ✅ Project item ID → Issue number mapping - Dynamic but expensive to query

**Cache invalidation**:

- Session restart: Clear all caches (automatic)
- Project structure change: Manual reset via config flag
- New fields added: Manual reset or detect schema change

### Rate Limiting

**GitHub GraphQL API limits**:

- 5,000 points per hour (authenticated)
- Simple queries: 1 point
- Complex nested queries: 10-50 points

**Mitigation strategies**:

1. Use `gh project item-list` CLI (optimized, higher level)
2. Batch field updates when possible
3. Implement exponential backoff on rate limit errors
4. Cache aggressively to reduce API calls

**Rate limit handling example**:

```javascript
async _gh(args, options = {}) {
  try {
    // ... existing implementation ...
  } catch (err) {
    if (err.message.includes('rate limit')) {
      console.warn('[kanban] GitHub API rate limit hit, backing off for 60s');
      await new Promise(resolve => setTimeout(resolve, 60000));
      return this._gh(args, options);  // Retry once
    }
    throw err;
  }
}
```

---

## Migration & Backward Compatibility

### No Breaking Changes

**Default behavior unchanged**:

- `GITHUB_PROJECT_MODE` defaults to `"issues"` (current behavior)
- Existing users continue reading from repo issues
- No config changes required

**Opt-in via configuration**:

```bash
# Enable project sync
GITHUB_PROJECT_MODE=kanban
GITHUB_PROJECT_OWNER=virtengine
GITHUB_PROJECT_NUMBER=3
```

**Graceful degradation**:

- If project not found → Fall back to repo issues
- If Status field missing → Log warning, skip sync
- If item not in project → Log warning, continue

### Migration Steps

For users wanting to enable project sync:

1. **Verify gh CLI version**: `gh version` (need Projects support)
2. **Verify auth scope**: `gh auth status` (need `project` scope)
3. **Set configuration**:
   ```bash
   export GITHUB_PROJECT_MODE=kanban
   export GITHUB_PROJECT_OWNER=virtengine
   export GITHUB_PROJECT_NUMBER=3
   ```
4. **Test read access**:
   ```bash
   gh project item-list 3 --owner virtengine --format json
   ```
5. **Restart openfleet**: `npm run monitor`
6. **Verify sync**: Check project board after status change

---

## Next Steps

### Immediate Actions

1. **Review documentation**: Validate API patterns and examples
2. **Spike implementation**: Test `gh project item-list` and GraphQL mutations
3. **Prototype Phase 1**: Implement `listTasksFromProject()` with sample data
4. **Create test fixtures**: Mock gh CLI responses for unit tests

### Implementation Order

1. **Phase 1 foundation** (Week 1):
   - `getProjectNodeId()` + caching
   - `getProjectFields()` + caching
   - `listTasksFromProject()` basic implementation
   - Unit tests for read operations

2. **Phase 1 polish** (Week 2):
   - `_normaliseProjectItem()` helper
   - Update `listTasks()` to use project mode
   - Integration tests
   - Manual testing with real project

3. **Phase 2 foundation** (Week 3):
   - `syncStatusToProject()` implementation
   - Status mapping configuration
   - Update `updateTaskStatus()` to sync
   - Unit tests for write operations

4. **Phase 2 polish** (Week 4):
   - Error handling and retry logic
   - Rate limit handling
   - Integration tests
   - Documentation updates

5. **Phase 3** (Future):
   - Evaluate demand for advanced features
   - Prioritize based on user feedback

---

## References

- **Main documentation**: [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md)
- **Quick reference**: [GITHUB_PROJECTS_V2_QUICKSTART.md](./GITHUB_PROJECTS_V2_QUICKSTART.md)
- **GitHub docs**: [Projects v2 API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- **GraphQL schema**: [ProjectV2 Object](https://docs.github.com/en/graphql/reference/objects#projectv2)
- **CLI reference**: [gh project](https://cli.github.com/manual/gh_project)

---

## Success Criteria

### Phase 1 Complete When:

- ✅ Can read tasks from project board via `listTasks()`
- ✅ Project items normalized to KanbanTask format
- ✅ Field metadata cached and accessible
- ✅ Unit tests pass (>80% coverage)
- ✅ Manual testing validates real project reads

### Phase 2 Complete When:

- ✅ Status updates sync to project Status field
- ✅ Status mapping configurable via env vars
- ✅ Graceful degradation when project unavailable
- ✅ Rate limiting handled with backoff
- ✅ Integration tests pass (end-to-end scenarios)
- ✅ Documentation updated with examples

### Phase 3 Complete When:

- ✅ Custom field sync working (if implemented)
- ✅ Iteration/sprint sync working (if implemented)
- ✅ Batch operations functional (if implemented)
- ✅ Webhook integration active (if implemented)

---

## Appendix: Example Output

### `gh project item-list` Output

```json
[
  {
    "id": "PVTI_lADOABC123",
    "content": {
      "type": "Issue",
      "number": 123,
      "title": "Add authentication support",
      "url": "https://github.com/virtengine/virtengine/issues/123",
      "state": "OPEN",
      "body": "Implement JWT-based authentication..."
    },
    "status": "In Progress",
    "assignees": ["username"],
    "labels": ["enhancement", "priority:high"]
  }
]
```

### `gh project field-list` Output

```json
[
  {
    "id": "PVTF_lADOXYZ456",
    "name": "Status",
    "type": "ProjectV2SingleSelectField",
    "options": [
      { "id": "f75ad846", "name": "Todo" },
      { "id": "47fc9ee4", "name": "In Progress" },
      { "id": "98236657", "name": "Done" }
    ]
  },
  {
    "id": "PVTIF_lADOXYZ999",
    "name": "Sprint",
    "type": "ProjectV2IterationField",
    "configuration": {
      "iterations": [
        {
          "id": "cfc16e4d",
          "title": "Sprint 1",
          "startDate": "2026-02-01",
          "duration": 14
        }
      ]
    }
  }
]
```

### Normalized `KanbanTask` Format

```javascript
{
  id: "123",
  title: "Add authentication support",
  description: "Implement JWT-based authentication...",
  status: "inprogress",  // Normalized from project "In Progress"
  assignee: "username",
  priority: "high",
  projectId: "virtengine/virtengine",
  branchName: null,
  prNumber: null,
  meta: {
    url: "https://github.com/virtengine/virtengine/issues/123",
    state: "OPEN",
    projectItemId: "PVTI_lADOABC123",
    projectFields: {
      "Status": "In Progress",
      "Sprint": "Sprint 1",
      "Estimated Hours": "8"
    },
    labels: ["enhancement", "priority:high"],
    codex: {
      isIgnored: false,
      isClaimed: true,
      isWorking: true,
      isStale: false
    }
  },
  backend: "github"
}
```

---

**End of Research Summary** | Ready for Implementation
