# GitHub Projects v2 Integration - Quick Start

This is a companion document to [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md) providing the TL;DR version.

## Current State

**Implemented (Phase 1 + 2 + 3)**:

- Read tasks from Projects v2 boards (`GITHUB_PROJECT_MODE=kanban`)
- Sync status updates to project `Status` field (`GITHUB_PROJECT_AUTO_SYNC=true`)
- Generic field sync helper for text/number/date/single-select

**Implemented in Phase 3**:

- Iteration sync helper (`syncIterationToProject`)
- Batch project field/status updates (GraphQL aliases)
- Webhook-driven sync trigger path (`/api/webhooks/github/project-sync`)
- Project-field filtering (`filters.projectField`)
- Draft issue creation/conversion support

## What You Need to Know

### 1. Projects v2 Uses GraphQL Only

No REST API. Two access patterns:

- **High-level**: `gh project item-list`, `gh project field-list` (easiest)
- **Low-level**: `gh api graphql -f query='...'` (for mutations)

### 2. Everything Needs Node IDs

Not numbers. You must fetch these first:

- Project ID: `PVT_kwDOABCDEF` (from project number)
- Item ID: `PVTI_lADOABC123` (when adding/listing items)
- Field ID: `PVTF_lADOXYZ456` (from field list)
- Option ID: `f75ad846` (for Status: "Todo" → ID)

### 3. Key Commands

```bash
# Get project ID
gh api graphql -f query='
  query {
    organization(login: "virtengine") {
      projectV2(number: 3) { id title }
    }
  }
'

# List items (tasks) in project
gh project item-list 3 --owner virtengine --format json

# List fields and their option IDs
gh project field-list 3 --owner virtengine --format json

# Update Status field (requires GraphQL mutation)
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

## Implementation Checklist

### Phase 1: Read from Projects

- [x] `getProjectNodeId(projectNumber)` - Cache project ID
- [x] `getProjectFields(projectNumber)` - Cache field metadata
- [x] `listTasksFromProject(projectNumber)` - Read items via `gh project item-list`
- [x] `_getProjectItemIdForIssue(projectNumber, issueNumber)` - Lookup helper
- [x] Update `listTasks()` to use project board when `mode=kanban`

### Phase 2: Write to Projects

- [x] `syncStatusToProject(issueNumber, projectNumber, status)` - Update Status field
- [x] Update `updateTaskStatus()` to call `syncStatusToProject()`
- [x] Add status mapping config (env vars or config file)

### Phase 3: Advanced (Optional)

- [x] `syncFieldToProject()` - Generic field updates
- [x] `syncIterationToProject()` - Sprint field updates
- [x] Batch operations for performance
- [x] Webhook support for real-time sync

## Configuration

```bash
# .env additions
GITHUB_PROJECT_MODE=kanban  # Enable project sync (default: "issues")
GITHUB_PROJECT_OWNER=virtengine
GITHUB_PROJECT_NUMBER=3

# Optional: Custom status mapping
GITHUB_PROJECT_STATUS_TODO="Todo"
GITHUB_PROJECT_STATUS_INPROGRESS="In Progress"
GITHUB_PROJECT_STATUS_DONE="Done"
```

## Code Patterns

### Read Pattern

```javascript
// List tasks from project board
const items = await this._gh([
  "project",
  "item-list",
  "3",
  "--owner",
  "virtengine",
  "--format",
  "json",
]);
```

### Write Pattern

```javascript
// Update Status field
const mutation = `
  mutation {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: "${projectId}"
        itemId: "${itemId}"
        fieldId: "${statusFieldId}"
        value: { singleSelectOptionId: "${optionId}" }
      }
    ) { projectV2Item { id } }
  }
`;
await this._gh(["api", "graphql", "-f", `query=${mutation}`]);
```

## Testing

```bash
# Manual test
cd scripts/openfleet
export GITHUB_PROJECT_MODE=kanban
export GITHUB_PROJECT_OWNER=virtengine
export GITHUB_PROJECT_NUMBER=3

# List tasks from project
node -e "
  import('./kanban-adapter.mjs').then(async ({ listTasks }) => {
    const tasks = await listTasks('virtengine/virtengine');
    console.log('Tasks:', tasks.length);
  });
"
```

## Performance Tips

1. **Cache aggressively**: Project ID, field metadata, item IDs
2. **Use high-level commands**: `gh project item-list` > GraphQL queries
3. **Batch updates**: Group multiple field updates when possible
4. **Rate limit handling**: Implement exponential backoff

## Migration

**No breaking changes**. Existing behavior (reading from repo issues) remains default.

To enable project sync:

1. Set `GITHUB_PROJECT_MODE=kanban`
2. Configure `GITHUB_PROJECT_OWNER` and `GITHUB_PROJECT_NUMBER`
3. Restart openfleet

## Full Documentation

See [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md) for:

- Complete API reference with examples
- All GraphQL queries and mutations
- Detailed implementation guide with code samples
- Error handling and edge cases
- Testing strategy
- Rate limiting considerations

Monitoring and operations:

- [GITHUB_PROJECTS_V2_MONITORING.md](./GITHUB_PROJECTS_V2_MONITORING.md)
