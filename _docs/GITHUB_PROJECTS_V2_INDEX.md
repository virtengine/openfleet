# GitHub Projects v2 Integration - Documentation Index

**Created**: 2026-02-15  
**Purpose**: Central hub for all GitHub Projects v2 integration documentation

---

## Quick Links

| Document                                                                         | Purpose                     | Audience                             |
| -------------------------------------------------------------------------------- | --------------------------- | ------------------------------------ |
| **[Quickstart Guide](./GITHUB_PROJECTS_V2_QUICKSTART.md)**                       | Get started fast (5KB)      | Implementers needing quick reference |
| **[API Reference](./GITHUB_PROJECTS_V2_API.md)**                                 | Complete API guide (28KB)   | Implementers needing every detail    |
| **[Research Summary](./GITHUB_PROJECTS_V2_RESEARCH_SUMMARY.md)**                 | Full research & plan (16KB) | Project managers, reviewers          |
| **[Implementation Checklist](./GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md)** | Progress tracker (11KB)     | Implementers tracking work           |

---

## The Problem

**Current State**: GitHubAdapter only **adds issues to projects** (one-way).

**Missing Capabilities**:

- ❌ Read tasks FROM project boards
- ❌ Sync status TO project Status field
- ❌ Read/write custom project fields
- ❌ Update iteration/sprint fields
- ❌ Manage project item metadata

**Impact**: Can't use GitHub Projects v2 as primary task board for openfleet.

---

## The Solution

**Three-phase implementation**:

### Phase 1: Read Support (Non-Breaking)

- Read tasks from project boards
- Normalize to KanbanTask format
- Opt-in via `GITHUB_PROJECT_MODE=kanban`
- Backward compatible (default: repo issues)

### Phase 2: Write Support (Bidirectional Sync)

- Sync status updates to project Status field
- Automatic sync on `updateTaskStatus()`
- Configurable status mappings
- Graceful error handling

### Phase 3: Advanced Features (Optional)

- Custom field sync
- Iteration/sprint support
- Batch operations
- Webhook integration

---

## Documentation Overview

### 1. Quickstart Guide

**File**: [GITHUB_PROJECTS_V2_QUICKSTART.md](./GITHUB_PROJECTS_V2_QUICKSTART.md)  
**Size**: 5KB  
**Read Time**: 5 minutes

**Contents**:

- Current gap summary
- Key concepts (GraphQL, node IDs)
- Essential commands only
- Implementation checklist
- Configuration examples
- Testing commands

**Use When**: You need to get started quickly or refresh your memory during implementation.

---

### 2. API Reference

**File**: [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md)  
**Size**: 28KB  
**Read Time**: 30 minutes

**Contents**:

- Current state analysis (code references)
- What's missing (detailed gaps)
- API overview (GraphQL patterns, authentication)
- Reading project data (3 query types with examples)
- Writing project data (3 mutation types with examples)
- Implementation plan (3 phases with method signatures)
- Configuration updates (env vars, schema)
- Helper methods (complete code examples)
- Testing plan (unit, integration, manual)
- Migration guide (backward compatible)
- Performance considerations (caching, rate limits)
- Appendix with full working code

**Use When**: You need the authoritative reference with all examples and edge cases covered.

---

### 3. Research Summary

**File**: [GITHUB_PROJECTS_V2_RESEARCH_SUMMARY.md](./GITHUB_PROJECTS_V2_RESEARCH_SUMMARY.md)  
**Size**: 16KB  
**Read Time**: 15 minutes

**Contents**:

- Problem statement
- Research findings (API architecture, key commands)
- Current code analysis
- Documentation created
- Implementation plan (3 phases)
- Testing strategy
- Performance considerations
- Migration & backward compatibility
- Next steps
- Success criteria
- Example outputs

**Use When**: You need to understand the big picture, review decisions, or present to stakeholders.

---

### 4. Implementation Checklist

**File**: [GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md](./GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md)  
**Size**: 11KB  
**Format**: Markdown checkboxes

**Contents**:

- Phase 1 tasks (read support)
- Phase 2 tasks (write support)
- Phase 3 tasks (advanced features)
- Testing requirements
- Documentation updates
- Deployment checklist
- Sign-off criteria
- Progress tracking

**Use When**: You're actively implementing and need to track progress, or reviewing completeness.

---

## Related Documentation

### Existing OpenFleet Docs

| Document                                                       | Relation to Projects v2                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [KANBAN_GITHUB_ENHANCEMENT.md](./KANBAN_GITHUB_ENHANCEMENT.md) | Issue-level shared state (labels + comments). Projects v2 is board-level sync. |
| [GITHUB_ADAPTER_QUICK_REF.md](./GITHUB_ADAPTER_QUICK_REF.md)   | Quick reference for current GitHub adapter. Now includes Projects v2 links.    |
| [SHARED_STATE_INTEGRATION.md](./SHARED_STATE_INTEGRATION.md)   | Multi-agent coordination via issue state. Orthogonal to project sync.          |

### External Resources

| Resource                    | URL                                                                                                                                    | Purpose                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| GitHub Projects v2 API Docs | [Link](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) | Official API documentation |
| ProjectV2 GraphQL Schema    | [Link](https://docs.github.com/en/graphql/reference/objects#projectv2)                                                                 | GraphQL object reference   |
| gh CLI Manual               | [Link](https://cli.github.com/manual/gh_project)                                                                                       | CLI command reference      |

---

## Getting Started

### For Reviewers

1. Start with [Research Summary](./GITHUB_PROJECTS_V2_RESEARCH_SUMMARY.md) (15 min)
2. Skim [API Reference](./GITHUB_PROJECTS_V2_API.md) for completeness
3. Review [Implementation Checklist](./GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md) for scope

### For Implementers

1. Read [Quickstart Guide](./GITHUB_PROJECTS_V2_QUICKSTART.md) (5 min)
2. Keep [API Reference](./GITHUB_PROJECTS_V2_API.md) open for copy-paste
3. Use [Implementation Checklist](./GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md) to track work

### For Users

1. Read "Configuration" section in [API Reference](./GITHUB_PROJECTS_V2_API.md)
2. Follow migration steps in [Research Summary](./GITHUB_PROJECTS_V2_RESEARCH_SUMMARY.md)
3. Test with manual commands from [Quickstart Guide](./GITHUB_PROJECTS_V2_QUICKSTART.md)

---

## Key Takeaways

### 🔑 Technical Key Points

1. **Projects v2 uses GraphQL exclusively** - No REST API
2. **Everything requires node IDs** - Not issue numbers or project numbers
3. **Two-step process**: Get node IDs first, then mutate
4. **Caching is critical** - Project/field metadata rarely changes
5. **Rate limiting exists** - 5,000 points/hour, implement backoff

### 🎯 Implementation Key Points

1. **Phase 1 is non-breaking** - Opt-in via config, default unchanged
2. **Use high-level CLI** - `gh project item-list` > raw GraphQL for reads
3. **Status mapping is configurable** - Env vars for flexibility
4. **Graceful degradation** - Log warnings, don't crash on missing fields
5. **Test thoroughly** - Unit, integration, manual testing required

### 📋 Process Key Points

1. **Research complete** - All API patterns documented
2. **Three-phase plan** - Read → Write → Advanced
3. **Backward compatible** - No changes to existing users
4. **Well documented** - 60KB+ of guides and examples
5. **Ready to implement** - Checklist tracks all work items

---

## FAQ

### Q: Do I need to read all 60KB of documentation?

**A**: No. Start with the [Quickstart Guide](./GITHUB_PROJECTS_V2_QUICKSTART.md) (5KB), then reference the [API docs](./GITHUB_PROJECTS_V2_API.md) as needed during implementation.

### Q: Will this break existing users?

**A**: No. The default behavior (reading from repo issues) is unchanged. Users must explicitly enable `GITHUB_PROJECT_MODE=kanban` to use project board sync.

### Q: Can I sync only specific fields?

**A**: Yes. Phase 2 includes a generic `syncFieldToProject()` method for any field type (text, number, date, single-select).

### Q: What if my project doesn't have a "Status" field?

**A**: The code logs a warning and gracefully skips sync. Status updates still work on the issue itself (labels).

### Q: Does this require GitHub App or special permissions?

**A**: No. It uses the standard `gh` CLI with `project` scope. Users authenticate with `gh auth login --scopes "project"`.

### Q: What's the performance impact?

**A**: Minimal with caching. Project metadata is cached per session. Rate limiting is 5,000 points/hour, plenty for typical usage.

### Q: Can I use this with GitHub Enterprise?

**A**: Yes, as long as Projects v2 is enabled. The `gh` CLI supports GitHub Enterprise via `GH_HOST` environment variable.

### Q: What if I'm already using Vibe-Kanban or Jira?

**A**: No conflict. This adds GitHub Projects v2 as an option. Existing VK and Jira adapters are unchanged.

---

## Status & Timeline

**Research Phase**: ✅ Complete (2026-02-15)  
**Documentation**: ✅ Complete (2026-02-15)  
**Phase 1 Implementation**: ✅ Complete (2026-02-16) — Read support, caching, normalization  
**Phase 2 Implementation**: ✅ Complete (2026-02-16) — Write support, auto-sync, rate limiting  
**Phase 3 Implementation**: ⬜️ Not Started

**Next Action**: Manual testing, code review, Phase 3 scoping.

---

## Contributing

### Updating This Documentation

When updating any Projects v2 documentation:

1. **Update the source file** (API Reference, Quickstart, etc.)
2. **Update this index** if structure changes
3. **Update Implementation Checklist** if tasks change
4. **Keep cross-references in sync** (update all links)

### Reporting Issues

If you find errors or gaps:

1. **Check all 4 documents** - The answer may be elsewhere
2. **File an issue** with document name and section
3. **Propose a fix** if you know the solution

---

## Changelog

| Date       | Change                                          | Author             |
| ---------- | ----------------------------------------------- | ------------------ |
| 2026-02-15 | Initial documentation created                   | GitHub Copilot CLI |
| 2026-02-15 | Added cross-references to existing docs         | GitHub Copilot CLI |
| 2026-02-16 | Phase 1 & 2 implementation complete             | GitHub Copilot     |
| 2026-02-16 | 37 unit tests passing, 1162 total tests passing | GitHub Copilot     |

---

## License

This documentation is part of the VirtEngine openfleet project and follows the same license as the main repository.

---

**Ready to start?** → [Quickstart Guide](./GITHUB_PROJECTS_V2_QUICKSTART.md)  
**Need details?** → [API Reference](./GITHUB_PROJECTS_V2_API.md)  
**Track progress?** → [Implementation Checklist](./GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md)
