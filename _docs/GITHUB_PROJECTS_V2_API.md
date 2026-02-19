# GitHub Projects v2 (GraphQL) API Integration Guide

## Executive Summary

This document outlines the GitHub Projects v2 API integration requirements for openfleet. The current implementation only **links issues to projects** but does NOT:

- Read tasks FROM project boards
- Sync status updates TO project fields (Status column)
- Read/write custom project fields
- Update iteration/sprint fields
- Manage project item metadata

This guide provides the API patterns needed for full bidirectional sync.

---

## Current State Analysis

### What's Already Implemented

**Location**: `scripts/openfleet/kanban-adapter.mjs` → GitHubAdapter class

**Current Capability**: `_ensureIssueLinkedToProject(issueUrl)`

- Uses `gh project item-add <number> --owner <org> --url <issueUrl>`
- Adds issues to a project board when created
- Only works when `GITHUB_PROJECT_MODE=kanban`
- No status sync, no field updates, no reading from projects

**Code Reference**:

```javascript
// kanban-adapter.mjs lines 1125-1154
async _ensureIssueLinkedToProject(issueUrl) {
  if (this._projectMode !== "kanban") return;
  const owner = String(this._projectOwner || "").trim();
  if (!owner || !issueUrl) return;
  const projectNumber = await this._resolveProjectNumber();
  if (!projectNumber) return;

  try {
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
  } catch (err) {
    const text = String(err?.message || err).toLowerCase();
    if (text.includes("already") && text.includes("item")) {
      return;
    }
    console.warn(
      `[kanban] failed to add issue to project ${owner}/${projectNumber}: ${err.message || err}`,
    );
  }
}
```

### Configuration

From `.env.example`:

```bash
# GITHUB_PROJECT_MODE=issues  # Default: read from repo issues (current behavior)
# GITHUB_PROJECT_MODE=kanban  # Links issues to project, but doesn't sync status

# Project identification (for kanban mode)
# GITHUB_PROJECT_OWNER=your-org
# GITHUB_PROJECT_TITLE=OpenFleet
# GITHUB_PROJECT_NUMBER=3
```

### What's Missing

1. **Read tasks FROM project boards**: Currently only reads from repo issues via `gh issue list`
2. **Sync status TO project Status field**: When task status changes, update project board column
3. **Read custom project fields**: Cannot query project-specific metadata
4. **Write custom project fields**: Cannot set custom field values
5. **Iteration/sprint sync**: No support for iteration fields
6. **Project item metadata**: Cannot read/update project-level item properties

---

## GitHub Projects v2 API Overview

### Key Concepts

**Projects v2** uses GraphQL API exclusively. The GitHub CLI (`gh`) provides two access patterns:

1. **High-level commands**: `gh project item-list`, `gh project field-list`, etc.
2. **Low-level GraphQL**: `gh api graphql -f query='...'` for complex operations

### Essential Node IDs

Projects v2 requires node IDs (not numbers) for mutations:

- **Project ID**: `PVT_kwDOABCDEF` (get from project number)
- **Item ID**: `PVTI_lADOABC123` (get when adding item or listing items)
- **Field ID**: `PVTF_lADOXYZ456` (get from field list)
- **Option ID**: `f75ad846` (for single select fields like Status)
- **Iteration ID**: `cfc16e4d` (for iteration/sprint fields)

### Authentication

All commands require `gh` CLI authenticated with `project` scope:

```bash
gh auth login --scopes "project"
gh auth status  # Verify project scope is present
```

---

## Reading Project Data

### 1. Get Project Node ID

**From project number**:

```bash
# For organization projects
gh api graphql -f query='
  query {
    organization(login: "virtengine") {
      projectV2(number: 3) {
        id
        title
      }
    }
  }
'

# Response:
# {
#   "data": {
#     "organization": {
#       "projectV2": {
#         "id": "PVT_kwDOABCDEF",
#         "title": "OpenFleet Tasks"
#       }
#     }
#   }
# }
```

**Wrapper method needed**:

```javascript
async getProjectNodeId(projectNumber) {
  const query = `
    query {
      organization(login: "${this._projectOwner}") {
        projectV2(number: ${projectNumber}) {
          id
          title
        }
      }
    }
  `;
  const result = await this._gh(['api', 'graphql', '-f', `query=${query}`]);
  return result?.data?.organization?.projectV2?.id;
}
```

### 2. List Project Items (Tasks)

**High-level CLI** (recommended for reading):

```bash
# List all items in project
gh project item-list 3 --owner virtengine --format json --limit 100

# Output format:
# [
#   {
#     "id": "PVTI_lADOABC123",
#     "content": {
#       "type": "Issue",
#       "number": 123,
#       "title": "Add authentication",
#       "url": "https://github.com/virtengine/virtengine/issues/123",
#       "state": "OPEN"
#     },
#     "status": "In Progress",    # Project Status field value
#     "assignees": ["username"],
#     "labels": ["bug", "high-priority"]
#   }
# ]
```

**GraphQL alternative** (for complex queries):

```bash
gh api graphql -f query='
  query {
    node(id: "PVT_kwDOABCDEF") {
      ... on ProjectV2 {
        items(first: 100) {
          nodes {
            id
            type
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
            content {
              ... on Issue {
                number
                title
                state
                assignees(first: 10) { nodes { login } }
              }
              ... on PullRequest {
                number
                title
                state
              }
            }
          }
        }
      }
    }
  }
'
```

**Wrapper method needed**:

```javascript
async listTasksFromProject(projectNumber) {
  const args = [
    'project',
    'item-list',
    String(projectNumber),
    '--owner',
    this._projectOwner,
    '--format',
    'json',
    '--limit',
    '1000'
  ];
  const items = await this._gh(args);
  return (Array.isArray(items) ? items : []).map(item => this._normaliseProjectItem(item));
}
```

### 3. Get Project Field Metadata

**List all fields in project**:

```bash
gh project field-list 3 --owner virtengine --format json

# Output:
# [
#   {
#     "id": "PVTF_lADOXYZ456",
#     "name": "Status",
#     "type": "ProjectV2SingleSelectField",
#     "options": [
#       { "id": "f75ad846", "name": "Todo" },
#       { "id": "47fc9ee4", "name": "In Progress" },
#       { "id": "98236657", "name": "Done" }
#     ]
#   },
#   {
#     "id": "PVTF_lADOABC789",
#     "name": "Priority",
#     "type": "ProjectV2SingleSelectField",
#     "options": [
#       { "id": "a1b2c3d4", "name": "Low" },
#       { "id": "e5f6g7h8", "name": "Medium" },
#       { "id": "i9j0k1l2", "name": "High" }
#     ]
#   },
#   {
#     "id": "PVTIF_lADOXYZ999",
#     "name": "Sprint",
#     "type": "ProjectV2IterationField",
#     "configuration": {
#       "iterations": [
#         { "id": "cfc16e4d", "title": "Sprint 1", "startDate": "2026-02-01" }
#       ]
#     }
#   }
# ]
```

**Wrapper method needed**:

```javascript
async getProjectFields(projectNumber) {
  const args = [
    'project',
    'field-list',
    String(projectNumber),
    '--owner',
    this._projectOwner,
    '--format',
    'json'
  ];
  const fields = await this._gh(args);

  // Build lookup maps for easy access
  const fieldMap = {};
  for (const field of (Array.isArray(fields) ? fields : [])) {
    fieldMap[field.name.toLowerCase()] = field;
  }
  return fieldMap;
}
```

---

## Writing Project Data

### 1. Update Status Field

**Map openfleet statuses to project Status options**:

```javascript
// Status mapping
const STATUS_TO_PROJECT_OPTION = {
  todo: "Todo",
  inprogress: "In Progress",
  inreview: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};
```

**GraphQL mutation**:

```bash
gh api graphql -f query='
  mutation {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: "PVT_kwDOABCDEF"
        itemId: "PVTI_lADOABC123"
        fieldId: "PVTF_lADOXYZ456"
        value: {
          singleSelectOptionId: "47fc9ee4"
        }
      }
    ) {
      projectV2Item {
        id
      }
    }
  }
'
```

**Wrapper method needed**:

```javascript
async syncStatusToProject(issueNumber, projectNumber, status) {
  // 1. Get project node ID
  const projectId = await this.getProjectNodeId(projectNumber);
  if (!projectId) {
    console.warn(`[kanban] Could not resolve project ID for #${projectNumber}`);
    return false;
  }

  // 2. Get field metadata (cached)
  const fields = await this.getProjectFields(projectNumber);
  const statusField = fields['status'];
  if (!statusField) {
    console.warn(`[kanban] Project #${projectNumber} has no Status field`);
    return false;
  }

  // 3. Map status to option ID
  const projectStatusName = STATUS_TO_PROJECT_OPTION[status];
  const option = statusField.options?.find(opt => opt.name === projectStatusName);
  if (!option) {
    console.warn(`[kanban] Status "${status}" has no project option mapping`);
    return false;
  }

  // 4. Find item ID for this issue
  const itemId = await this._getProjectItemIdForIssue(projectNumber, issueNumber);
  if (!itemId) {
    console.warn(`[kanban] Issue #${issueNumber} not found in project #${projectNumber}`);
    return false;
  }

  // 5. Update field
  const mutation = `
    mutation {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: "${projectId}"
          itemId: "${itemId}"
          fieldId: "${statusField.id}"
          value: {
            singleSelectOptionId: "${option.id}"
          }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  try {
    await this._gh(['api', 'graphql', '-f', `query=${mutation}`]);
    return true;
  } catch (err) {
    console.warn(`[kanban] Failed to sync status to project: ${err.message}`);
    return false;
  }
}
```

### 2. Update Custom Text/Number/Date Fields

**Example: Update "Estimated Hours" field**:

```bash
gh api graphql -f query='
  mutation {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: "PVT_kwDOABCDEF"
        itemId: "PVTI_lADOABC123"
        fieldId: "PVTF_lADO_CUSTOM"
        value: {
          text: "8 hours"       # or: number: 8.0, or: date: "2026-02-20"
        }
      }
    ) {
      projectV2Item {
        id
      }
    }
  }
'
```

### 3. Update Iteration/Sprint Field

**Set current sprint**:

```bash
gh api graphql -f query='
  mutation {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: "PVT_kwDOABCDEF"
        itemId: "PVTI_lADOABC123"
        fieldId: "PVTIF_lADOXYZ999"
        value: {
          iterationId: "cfc16e4d"
        }
      }
    ) {
      projectV2Item {
        id
      }
    }
  }
'
```

---

## Implementation Plan

### Phase 1: Read Support (Non-Breaking)

**Add new methods to GitHubAdapter**:

1. **`getProjectNodeId(projectNumber)`**
   - Convert project number to node ID
   - Cache result for session lifetime
   - Required for all mutations

2. **`getProjectFields(projectNumber)`**
   - List all fields with IDs and options
   - Cache result (fields rarely change)
   - Build lookup maps for Status, Priority, Iteration

3. **`listTasksFromProject(projectNumber)`**
   - Use `gh project item-list` to read from project board
   - Normalize to KanbanTask format
   - Include project-specific field values in `task.meta.projectFields`

4. **`_getProjectItemIdForIssue(projectNumber, issueNumber)`**
   - Find project item ID for a given issue number
   - Required for update operations
   - Cache results to reduce API calls

**Update existing `listTasks()` method**:

```javascript
async listTasks(_projectId, filters = {}) {
  // If project mode is "kanban", read from project board instead of repo issues
  if (this._projectMode === "kanban" && this._cachedProjectNumber) {
    return this.listTasksFromProject(this._cachedProjectNumber);
  }

  // Otherwise, use existing repo issue listing (current behavior)
  // ... existing implementation ...
}
```

### Phase 2: Write Support (Bidirectional Sync)

**Add new methods**:

1. **`syncStatusToProject(issueNumber, projectNumber, status)`**
   - Update project Status field when task status changes
   - Map openfleet statuses to project options
   - Called automatically from `updateTaskStatus()`

2. **`syncFieldToProject(issueNumber, projectNumber, fieldName, value)`**
   - Generic field update for custom fields
   - Support text, number, date, single-select types
   - Use for priority, assignee, custom metadata

3. **`syncIterationToProject(issueNumber, projectNumber, iterationName)`**
   - Set iteration/sprint field
   - Find iteration by name or startDate
   - Use for sprint planning integration

**Update existing `updateTaskStatus()` method**:

```javascript
async updateTaskStatus(issueNumber, status, options = {}) {
  // Update issue labels (existing behavior)
  // ...

  // NEW: Sync to project if configured
  if (this._projectMode === "kanban" && this._cachedProjectNumber) {
    await this.syncStatusToProject(
      issueNumber,
      this._cachedProjectNumber,
      status
    );
  }

  // Handle shared state (existing enhancement)
  // ...
}
```

### Phase 3: Advanced Features (Optional)

1. **Project view filtering**:
   - Filter by Status field values
   - Filter by custom field values
   - Support project-specific queries

2. **Batch operations**:
   - Bulk status updates
   - Bulk field updates
   - Reduce API calls for multi-agent scenarios

3. **Webhook integration**:
   - Listen for project item updates
   - Real-time sync without polling
   - Requires GitHub App or webhook setup

4. **Draft issues**:
   - Create draft issues directly in project
   - Convert drafts to real issues
   - Use `addProjectV2DraftIssue` mutation

---

## Configuration Updates

**New environment variables**:

```bash
# .env.example additions

# GitHub Project Mode
# - "issues": Read from repo issues only (default, current behavior)
# - "kanban": Read from project board AND sync status bidirectionally
GITHUB_PROJECT_MODE=kanban

# Project identification (required for kanban mode)
GITHUB_PROJECT_OWNER=virtengine
GITHUB_PROJECT_TITLE=OpenFleet
GITHUB_PROJECT_NUMBER=3

# Status field mapping (optional, defaults shown)
# Map openfleet statuses to your project's Status field options
# GITHUB_PROJECT_STATUS_TODO=Todo
# GITHUB_PROJECT_STATUS_INPROGRESS=In Progress
# GITHUB_PROJECT_STATUS_INREVIEW=In Review
# GITHUB_PROJECT_STATUS_DONE=Done
# GITHUB_PROJECT_STATUS_CANCELLED=Cancelled

# Enable automatic status sync (optional, default: true when mode=kanban)
# GITHUB_PROJECT_AUTO_SYNC=true
```

**Config schema updates**:

```json
{
  "kanban": {
    "backend": "github",
    "github": {
      "mode": "kanban",
      "project": {
        "owner": "virtengine",
        "number": 3,
        "autoSync": true,
        "statusMapping": {
          "todo": "Todo",
          "inprogress": "In Progress",
          "inreview": "In Review",
          "done": "Done",
          "cancelled": "Cancelled"
        }
      }
    }
  }
}
```

---

## Helper Methods Reference

### `_normaliseProjectItem(projectItem)`

Convert GitHub Projects v2 item format to KanbanTask:

```javascript
_normaliseProjectItem(item) {
  const content = item.content || {};
  const issueNumber = content.number || null;

  // Extract field values
  const projectFields = {};
  if (Array.isArray(item.fieldValues)) {
    for (const fv of item.fieldValues) {
      const fieldName = fv.field?.name || 'unknown';
      if (fv.text !== undefined) projectFields[fieldName] = fv.text;
      if (fv.name !== undefined) projectFields[fieldName] = fv.name;
      if (fv.number !== undefined) projectFields[fieldName] = fv.number;
      if (fv.date !== undefined) projectFields[fieldName] = fv.date;
    }
  }

  // Map project Status to codex status
  const projectStatus = projectFields['Status'] || 'Todo';
  const normalizedStatus = this._normalizeProjectStatus(projectStatus);

  return {
    id: String(issueNumber),
    title: content.title || 'Untitled',
    description: content.body || '',
    status: normalizedStatus,
    assignee: item.assignees?.[0] || null,
    priority: projectFields['Priority']?.toLowerCase() || null,
    projectId: `${this._owner}/${this._repo}`,
    branchName: null,  // Project doesn't track branches
    prNumber: content.type === 'PullRequest' ? String(issueNumber) : null,
    meta: {
      url: content.url,
      state: content.state,
      projectItemId: item.id,
      projectFields,
      labels: content.labels || [],
      codex: this._extractCodexLabels(content.labels || []),
    },
    backend: 'github',
  };
}

_normalizeProjectStatus(projectStatusName) {
  const map = {
    'todo': 'todo',
    'in progress': 'inprogress',
    'in review': 'inreview',
    'done': 'done',
    'cancelled': 'cancelled',
  };
  return map[projectStatusName.toLowerCase()] || 'todo';
}
```

---

## Testing Plan

### Unit Tests

1. **`getProjectNodeId()`**: Mock GraphQL response, verify ID extraction
2. **`getProjectFields()`**: Mock field list, verify caching and lookup maps
3. **`listTasksFromProject()`**: Mock item list, verify normalization
4. **`syncStatusToProject()`**: Mock mutations, verify correct field updates
5. **Status mapping**: Test all status transitions

### Integration Tests

1. **Create issue → Auto-add to project**: Existing test, verify still works
2. **Update status → Sync to project**: Change issue status, verify project Status field updates
3. **Read from project → List tasks**: Verify `listTasks()` reads from project when mode=kanban
4. **Project item not found**: Handle missing items gracefully
5. **Field not found**: Handle missing Status field gracefully

### Manual Testing

```bash
# Setup
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
    console.log('First task:', tasks[0]);
  });
"

# Test 2: Update status and sync
node -e "
  import('./kanban-adapter.mjs').then(async ({ updateTaskStatus, getTask }) => {
    await updateTaskStatus('123', 'inprogress');
    const task = await getTask('123');
    console.log('Updated task:', task);
  });
"

# Test 3: Check project board manually
gh project item-list 3 --owner virtengine --format json | jq '.[] | select(.content.number == 123)'
```

---

## Migration Guide

### For Existing Users

**No breaking changes**. Default behavior (reading from repo issues) is unchanged.

**To enable project board sync**:

1. Set `GITHUB_PROJECT_MODE=kanban` in `.env`
2. Configure project details:
   ```bash
   GITHUB_PROJECT_OWNER=your-org
   GITHUB_PROJECT_NUMBER=3
   ```
3. Restart openfleet: `npm run monitor`
4. Verify: `gh project item-list 3 --owner your-org --format json`

**To customize status mapping**:

1. List your project's Status field options:
   ```bash
   gh project field-list 3 --owner your-org --format json | jq '.[] | select(.name == "Status")'
   ```
2. Set environment variables to match your option names:
   ```bash
   GITHUB_PROJECT_STATUS_TODO="📋 Backlog"
   GITHUB_PROJECT_STATUS_INPROGRESS="🚀 In Progress"
   GITHUB_PROJECT_STATUS_DONE="✅ Done"
   ```

---

## Performance Considerations

### Caching Strategy

**Cache these for session lifetime**:

- Project node ID (from project number)
- Project field metadata (ID, options, iterations)
- Project item ID → Issue number mapping

**Invalidate cache when**:

- Project structure changes (rare)
- New fields added (manual reset)
- Session restart (automatic)

### Rate Limiting

**GitHub GraphQL API limits**:

- 5,000 points per hour for authenticated requests
- Simple queries cost 1 point
- Complex queries with nested fields cost more

**Mitigation strategies**:

1. Batch field updates when possible
2. Cache project metadata aggressively
3. Use `gh project item-list` CLI (higher-level, optimized)
4. Implement exponential backoff on rate limit errors

**Example rate limit handling**:

```javascript
async _gh(args, options = {}) {
  try {
    // ... existing implementation ...
  } catch (err) {
    if (err.message.includes('rate limit')) {
      console.warn('[kanban] GitHub API rate limit hit, backing off...');
      await new Promise(resolve => setTimeout(resolve, 60000));
      return this._gh(args, options);  // Retry once
    }
    throw err;
  }
}
```

---

## Reference Links

- [GitHub Projects v2 API Docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [ProjectV2 GraphQL Schema](https://docs.github.com/en/graphql/reference/objects#projectv2)
- [gh project CLI Reference](https://cli.github.com/manual/gh_project)
- [Existing GitHub Adapter Enhancement](./KANBAN_GITHUB_ENHANCEMENT.md)
- [Shared State Integration](./SHARED_STATE_INTEGRATION.md)

---

## Appendix: Complete Code Example

### New GitHubAdapter Methods

```javascript
// Cache for project metadata
_projectFieldsCache = new Map();  // projectNumber -> fields
_projectNodeIdCache = new Map();  // projectNumber -> node ID
_projectItemCache = new Map();    // "projectNum:issueNum" -> item ID

async getProjectNodeId(projectNumber) {
  const cacheKey = String(projectNumber);
  if (this._projectNodeIdCache.has(cacheKey)) {
    return this._projectNodeIdCache.get(cacheKey);
  }

  const query = `
    query {
      organization(login: "${this._projectOwner}") {
        projectV2(number: ${projectNumber}) {
          id
          title
        }
      }
    }
  `;

  try {
    const result = await this._gh(['api', 'graphql', '-f', `query=${query}`]);
    const projectId = result?.data?.organization?.projectV2?.id;
    if (projectId) {
      this._projectNodeIdCache.set(cacheKey, projectId);
    }
    return projectId;
  } catch (err) {
    console.warn(`[kanban] Failed to get project node ID: ${err.message}`);
    return null;
  }
}

async getProjectFields(projectNumber) {
  const cacheKey = String(projectNumber);
  if (this._projectFieldsCache.has(cacheKey)) {
    return this._projectFieldsCache.get(cacheKey);
  }

  const args = [
    'project',
    'field-list',
    String(projectNumber),
    '--owner',
    this._projectOwner,
    '--format',
    'json'
  ];

  try {
    const fields = await this._gh(args);
    const fieldMap = {};
    for (const field of (Array.isArray(fields) ? fields : [])) {
      fieldMap[field.name.toLowerCase()] = field;
    }
    this._projectFieldsCache.set(cacheKey, fieldMap);
    return fieldMap;
  } catch (err) {
    console.warn(`[kanban] Failed to get project fields: ${err.message}`);
    return {};
  }
}

async listTasksFromProject(projectNumber) {
  const args = [
    'project',
    'item-list',
    String(projectNumber),
    '--owner',
    this._projectOwner,
    '--format',
    'json',
    '--limit',
    '1000'
  ];

  try {
    const items = await this._gh(args);
    const normalized = (Array.isArray(items) ? items : [])
      .filter(item => item.content?.type === 'Issue')  // Skip PRs if needed
      .map(item => this._normaliseProjectItem(item));

    // Apply task label filter if enabled
    if (this._enforceTaskLabel) {
      return normalized.filter(task => this._isTaskScopedForCodex(task));
    }

    return normalized;
  } catch (err) {
    console.warn(`[kanban] Failed to list project items: ${err.message}`);
    return [];
  }
}

async _getProjectItemIdForIssue(projectNumber, issueNumber) {
  const cacheKey = `${projectNumber}:${issueNumber}`;
  if (this._projectItemCache.has(cacheKey)) {
    return this._projectItemCache.get(cacheKey);
  }

  // List items and find matching issue
  const items = await this.listTasksFromProject(projectNumber);
  const item = items.find(t => t.id === String(issueNumber));
  if (item?.meta?.projectItemId) {
    this._projectItemCache.set(cacheKey, item.meta.projectItemId);
    return item.meta.projectItemId;
  }

  return null;
}

async syncStatusToProject(issueNumber, projectNumber, status) {
  const projectId = await this.getProjectNodeId(projectNumber);
  if (!projectId) return false;

  const fields = await this.getProjectFields(projectNumber);
  const statusField = fields['status'];
  if (!statusField) {
    console.warn(`[kanban] Project has no Status field`);
    return false;
  }

  const STATUS_TO_PROJECT = {
    'todo': process.env.GITHUB_PROJECT_STATUS_TODO || 'Todo',
    'inprogress': process.env.GITHUB_PROJECT_STATUS_INPROGRESS || 'In Progress',
    'inreview': process.env.GITHUB_PROJECT_STATUS_INREVIEW || 'In Review',
    'done': process.env.GITHUB_PROJECT_STATUS_DONE || 'Done',
    'cancelled': process.env.GITHUB_PROJECT_STATUS_CANCELLED || 'Cancelled',
  };

  const projectStatusName = STATUS_TO_PROJECT[status];
  const option = statusField.options?.find(opt => opt.name === projectStatusName);
  if (!option) {
    console.warn(`[kanban] Status "${status}" -> "${projectStatusName}" not found in project options`);
    return false;
  }

  const itemId = await this._getProjectItemIdForIssue(projectNumber, issueNumber);
  if (!itemId) {
    console.warn(`[kanban] Issue #${issueNumber} not in project #${projectNumber}`);
    return false;
  }

  const mutation = `
    mutation {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: "${projectId}"
          itemId: "${itemId}"
          fieldId: "${statusField.id}"
          value: {
            singleSelectOptionId: "${option.id}"
          }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  try {
    await this._gh(['api', 'graphql', '-f', `query=${mutation}`]);
    console.log(`[kanban] Synced status for #${issueNumber} to project: ${status} -> ${projectStatusName}`);
    return true;
  } catch (err) {
    console.warn(`[kanban] Failed to sync status: ${err.message}`);
    return false;
  }
}
```

---

## Summary

This guide provides the complete API patterns needed for full GitHub Projects v2 integration:

✅ **Current**: Issues linked to projects  
🔨 **Phase 1**: Read tasks from project boards  
🔨 **Phase 2**: Sync status bidirectionally  
💡 **Phase 3**: Custom fields, iterations, advanced features

Implementation maintains backward compatibility and requires no changes for users who don't enable `GITHUB_PROJECT_MODE=kanban`.
