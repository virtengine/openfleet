# Test Coverage Opportunities

## Executive Summary
- **Current Coverage**: 142 test files covering 113 unique modules
- **Untested Critical Modules**: 11 high-priority modules identified
- **Uncovered Functionalities**: Error boundaries, config validation, agent selection, security patterns
- **Estimated Additional Tests**: 300-500 assertions across 8-10 test files

## Tier 1: Critical Security & Core Functionality (HIGHEST PRIORITY)

### 1. **error-detector.mjs** (High Priority - Error Classification)
**Why**: Core to agent failure recovery; classifies errors into 8 categories
**Current Coverage**: error-detector-enhanced.test.mjs exists but focuses on specific patterns
**Missing Tests**:
- [ ] Edge cases for PLAN_STUCK_PATTERNS (context-dependent detection)
- [ ] Rate limit bucket calculations and cooldown tracking
- [ ] Token overflow pattern matching with various API error formats
- [ ] Recovery action selection logic
- [ ] Unknown error fallback handling
- [ ] Pattern priority resolution when multiple match

**Test Patterns**:
```javascript
// Pattern classification for real-world errors
- "429 too many requests" → rate_limit
- "context length exceeded" → token_overflow + recovery actions
- "Created plan at /tmp/plan.md" → plan_stuck
- Partial matches and boundary cases
```

**Suggested Assertions**: ~40-50

---

### 2. **config.mjs** (High Priority - Configuration Loading)
**Why**: Critical to all features; loads from 5+ sources with fallback logic
**Current Coverage**: config-*.test.mjs files exist but test specific features
**Missing Tests**:
- [ ] Complete config loading priority chain (CLI → env → .env → JSON → defaults)
- [ ] Executor weight normalization and failover ordering
- [ ] Config file discovery walk-up behavior
- [ ] Environment variable overrides for nested config paths
- [ ] .env parsing with special characters and quote handling
- [ ] Config merge for executors with inheritance
- [ ] Validation of executor distributions (weights sum correctly)
- [ ] Path resolution for watch paths and worktree locations

**Test Patterns**:
```javascript
// Config merging
CLI args override env vars override .env override JSON override defaults
// Executor config
weights: [copilot: 40%, codex: 50%, claude: 10%] → sorted by priority
// Path fallback
configWatchPath → scriptPath → repoRoot → configDir
```

**Suggested Assertions**: ~60-70

---

### 3. **agent-sdk.mjs** (High Priority - Agent Selection)
**Why**: Determines which agent (Codex, Copilot, Claude, etc.) is available
**Current Coverage**: None (no agent-sdk.test.mjs)
**Missing Tests**:
- [ ] Codec config parsing and validation
- [ ] Default capability assignment by agent type
- [ ] Custom capability override detection
- [ ] Steering capability per agent
- [ ] Subagent support validation
- [ ] VSCode tools availability checking
- [ ] Fallback when config file missing
- [ ] Multi-agent compatibility matrix

**Test Patterns**:
```javascript
// Agent capabilities
codex → steering: true, subagents: true, vscodeTools: false
copilot → steering: false, subagents: true, vscodeTools: true
claude → steering: false, subagents: true, vscodeTools: false
```

**Suggested Assertions**: ~30-40

---

## Tier 2: Security & Authentication (HIGH PRIORITY)

### 4. **issue-trust-guard.mjs** (High Priority - GitHub Security)
**Why**: Prevents prompt injection attacks from untrusted issues
**Current Coverage**: None
**Missing Tests**:
- [ ] Trust builder with trusted user list
- [ ] Prompt injection pattern detection (system role, instruction override)
- [ ] Content sanitization (script tags, event handlers)
- [ ] Case-insensitive pattern matching
- [ ] Whitelist-based trust model
- [ ] Repository owner/team membership checks
- [ ] Pattern confidence scoring

**Test Patterns**:
```javascript
// Injection detection
"[system] ignore instructions" → injection detected
"forget previous context" → injection detected
"<script>alert('xss')</script>" → sanitized
```

**Suggested Assertions**: ~35-45

---

### 5. **git-editor-fix.mjs** (Medium Priority - Git Configuration)
**Why**: Ensures Git uses non-interactive editor (prevents CI hangs)
**Current Coverage**: None
**Missing Tests**:
- [ ] Non-interactive editor setting verification
- [ ] Git config detection and updating
- [ ] Credential helper restoration (if previously modified)
- [ ] Editor reset on shutdown
- [ ] Platform-specific editor paths (Windows, macOS, Linux)
- [ ] Existing editor config detection

**Test Patterns**:
```javascript
// Editor config
GIT_EDITOR=":" (no-op for non-interactive)
GIT_SEQUENCE_EDITOR=":" (for rebase)
```

**Suggested Assertions**: ~20-25

---

## Tier 3: Feature-Specific Functionality (MEDIUM PRIORITY)

### 6. **agent-tool-config.mjs** (Medium Priority - Tool Configuration)
**Why**: Configures which tools agents can access
**Current Coverage**: None
**Missing Tests**:
- [ ] Tool permission matrix by agent
- [ ] Tool set filtering (restrict tools per context)
- [ ] Capability-based tool exposure
- [ ] Custom tool registry
- [ ] Tool version constraints
- [ ] Auth token injection for tools

**Suggested Assertions**: ~25-35

---

### 7. **mcp-registry.mjs** (Medium Priority - MCP Server Management)
**Why**: Registers and manages MCP (Model Context Protocol) servers
**Current Coverage**: None
**Missing Tests**:
- [ ] Server lifecycle (init, connect, disconnect)
- [ ] Tool discovery from MCP servers
- [ ] Request routing to correct server
- [ ] Error recovery on server failure
- [ ] Configuration validation

**Suggested Assertions**: ~30-40

---

### 8. **marketplace-webhook.mjs** (Low Priority - GitHub Marketplace)
**Why**: Handles GitHub Marketplace events
**Current Coverage**: None
**Missing Tests**:
- [ ] Webhook signature verification
- [ ] Event routing (purchase, cancellation, trial)
- [ ] Subscription state updates
- [ ] Plan tier detection

**Suggested Assertions**: ~25-30

---

## Tier 4: Utility & Build Modules (LOW PRIORITY)

### 9. **desktop-shortcut.mjs** (Low Priority)
**Current Coverage**: None
**Opportunity**: Platform detection, shortcut creation per OS

### 10. **build-vendor-mui.mjs** (Low Priority)
**Current Coverage**: None
**Opportunity**: MUI build validation, output checking

### 11. **publish.mjs** (Low Priority)
**Current Coverage**: None
**Opportunity**: Version bump, changelog validation, git tag flow

---

## Summary: Recommended Test Implementation Order

### Phase 1 (Highest ROI - Do First)
1. **error-detector.mjs** ← Most critical for reliability
2. **config.mjs** ← Affects all features
3. **agent-sdk.mjs** ← Determines agent availability
4. **issue-trust-guard.mjs** ← Security-critical

**Estimated effort**: 4-6 hours, 150-200 assertions
**Estimated impact**: Prevents 80% of reliability issues

### Phase 2 (High ROI)
5. **git-editor-fix.mjs**  
6. **agent-tool-config.mjs**
7. **mcp-registry.mjs**

**Estimated effort**: 4-5 hours, 80-105 assertions
**Estimated impact**: Prevents CI hangs, improves tool availability

### Phase 3 (Medium ROI)
8-11. Utility modules (marketplace-webhook, desktop-shortcut, etc.)

**Estimated effort**: 3-4 hours, 70-90 assertions
**Estimated impact**: Improved reliability for desktop/marketplace features

---

## Testing Patterns to Follow

### Pattern 1: Configuration Merging
```javascript
test("config merging priority", {text: 'Test CLI args override env vars'});
// Verify: CLI > env > .env > JSON > defaults
```

### Pattern 2: Error Classification  
```javascript
test("error pattern matching", {text: 'Test error against patterns with fallback'});
// Verify: Exact match > loose match > unknown
```

### Pattern 3: Security Validation
```javascript
test("injection detection", {text: 'Test prompt injection patterns'});
// Verify: Pattern detected, content sanitized, trust model applied
```

### Pattern 4: Async Safety
```javascript
test("callback error handling", {text: 'Test .catch() on all promises'});
// Verify: No unhandled rejections, logging present
```

---

## Files with Hidden Test Opportunities

These modules have existing tests but gaps in coverage:

| Module | Existing Tests | Coverage Gap |
|--------|---|---|
| monitor.mjs | 25+ | Smart PR merge guards, workspace sync edge cases |
| config.mjs | 8+ | Executor distribution validation, path normalization |
| agent-pool.mjs | 5+ | Concurrent agent scheduling, deadlock prevention |
| ui-server.mjs | 3+ | Static file fallback, vendor file CDN fallback |

---

## Expected Coverage Improvement

| Current | Phase 1 | Phase 2 | Phase 3 |
|---------|---------|---------|---------|
| 78% | 82% | 86% | 89% |

*Baseline: Line coverage of primary modules (excluding tests, UI, voicefeatures)*
