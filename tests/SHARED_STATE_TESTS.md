# Shared State System Tests

Comprehensive test suite for the distributed task coordination system in openfleet.

## Test Files

### 1. `shared-state-manager.test.mjs`

Tests the core shared state manager functionality (`shared-state-manager.mjs`).

**Coverage:**

- **Claim lifecycle**: Initial claims, reclaims, conflicts, takeovers
- **Conflict resolution**: Active vs stale heartbeat detection, owner priority
- **Heartbeat management**: Renewal, staleness detection, TTL enforcement
- **Release operations**: Complete, failed, abandoned states
- **Retry logic**: `shouldRetryTask()` with various retry counts
- **Ignore flags**: Setting, clearing, and enforcement
- **Event logging**: Full lifecycle tracking, bounded log size
- **Corruption recovery**: Invalid JSON, missing structure
- **Statistics**: State counts, owner tracking, staleness detection
- **Cleanup**: Old state removal based on retention policy

**Key Test Scenarios:**

```javascript
// Claim with conflict resolution
it("allows takeover when existing owner heartbeat is stale", async () => {
  // Agent 1 claims with short TTL
  await claimTaskInSharedState("task", "agent-1", "token-1", 1, tempRoot);

  // Wait for staleness
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Agent 2 successfully takes over
  const result = await claimTaskInSharedState(
    "task",
    "agent-2",
    "token-2",
    300,
    tempRoot,
  );
  expect(result.success).toBe(true);
  expect(result.state.ownerId).toBe("agent-2");
  expect(result.state.retryCount).toBe(1);
});

// Retry count enforcement
it("returns false when retry count exceeds max", async () => {
  // Simulate 4 attempts
  for (let i = 0; i < 4; i++) {
    await claimTaskInSharedState(
      taskId,
      `agent-${i}`,
      `token-${i}`,
      300,
      tempRoot,
    );
    await releaseSharedState(taskId, `token-${i}`, "failed", "Error", tempRoot);
  }

  const result = await shouldRetryTask(taskId, 3, tempRoot);
  expect(result.shouldRetry).toBe(false);
  expect(result.reason).toContain("max_retries_exceeded");
});
```

### 2. `github-shared-state.test.mjs`

Tests GitHub integration for persisting/reading shared state via issue labels and comments.

**Coverage:**

- **persistSharedStateToIssue()**: Label management, structured comment creation/update
- **readSharedStateFromIssue()**: Comment parsing, validation, error handling
- **markTaskIgnored()**: Ignore label and comment creation
- **listTasks() enrichment**: Shared state data attached to task objects
- **Error handling**: Retries, API failures, malformed responses
- **Exported functions**: Module-level convenience exports

**Key Test Scenarios:**

```javascript
// Label and comment persistence
it("creates labels and comment for claimed state", async () => {
  const sharedState = {
    taskId: "42",
    ownerId: "agent-1/workstation-1",
    attemptToken: "token-123",
    attemptStarted: "2026-02-14T10:00:00Z",
    heartbeat: "2026-02-14T10:30:00Z",
    status: "claimed",
    retryCount: 0,
  };

  const result = await adapter.persistSharedStateToIssue(42, sharedState);
  expect(result).toBe(true);

  // Verify label was added
  const labelCall = execFileMock.mock.calls.find((c) =>
    c[1].includes("codex:claimed"),
  );
  expect(labelCall).toBeDefined();
});

// Comment parsing with validation
it("returns null for missing required fields", async () => {
  const incompleteState = { taskId: "42", ownerId: "agent-1" };
  mockGh(
    JSON.stringify([
      {
        id: 123,
        body: `<!-- openfleet-state\n${JSON.stringify(incompleteState)}\n-->\nIncomplete`,
      },
    ]),
  );

  const result = await adapter.readSharedStateFromIssue(42);
  expect(result).toBeNull();
});
```

### 3. `shared-state-integration.test.mjs`

End-to-end integration tests combining local state management with GitHub synchronization.

**Coverage:**

- **Full lifecycle**: Claim → work → heartbeat → release
- **Multi-agent conflicts**: Concurrent claims, stale detection, takeover
- **Recovery scenarios**: Stale sweep, abandoned task reclaim
- **Ignore flag workflow**: Prevention of retry, GitHub sync
- **Max retries**: Exhaustion tracking, cross-takeover counting
- **Statistics**: Monitoring, owner tracking
- **Error handling**: GitHub API failures, corruption recovery

**Key Test Scenarios:**

```javascript
// End-to-end flow
it("completes full lifecycle with local and GitHub sync", async () => {
  // 1. Claim task
  const claimResult = await sharedStateManager.claimTaskInSharedState(
    taskId,
    ownerId,
    attemptToken,
    300,
    tempRoot,
  );

  // 2. Persist to GitHub
  await kanbanAdapter.persistSharedStateToIssue(taskId, sharedState);

  // 3. Renew heartbeat
  await sharedStateManager.renewSharedStateHeartbeat(
    taskId,
    ownerId,
    attemptToken,
    tempRoot,
  );

  // 4. Update GitHub
  await kanbanAdapter.persistSharedStateToIssue(taskId, updatedState);

  // 5. Complete
  await sharedStateManager.releaseSharedState(
    taskId,
    attemptToken,
    "complete",
    undefined,
    tempRoot,
  );

  // Verify event log
  const finalState = await sharedStateManager.getSharedState(taskId, tempRoot);
  expect(finalState.eventLog.map((e) => e.event)).toContain("claimed");
  expect(finalState.eventLog.map((e) => e.event)).toContain("renewed");
  expect(finalState.eventLog.map((e) => e.event)).toContain("released");
});

// Multi-agent conflict with takeover
it("allows takeover when first agent becomes stale", async () => {
  // Agent 1 claims
  await sharedStateManager.claimTaskInSharedState(
    taskId,
    agent1,
    "token-1",
    1,
    tempRoot,
  );
  await kanbanAdapter.persistSharedStateToIssue(taskId, state1);

  // Wait for staleness
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Agent 2 detects stale state and takes over
  const claim2 = await sharedStateManager.claimTaskInSharedState(
    taskId,
    agent2,
    "token-2",
    300,
    tempRoot,
  );
  expect(claim2.success).toBe(true);
  expect(claim2.state.ownerId).toBe(agent2);
  expect(claim2.state.retryCount).toBe(1);
});

// Max retries exhaustion
it("prevents retry after max attempts", async () => {
  // Exhaust retries
  for (let i = 0; i <= maxRetries; i++) {
    await sharedStateManager.claimTaskInSharedState(
      taskId,
      `agent-${i}`,
      `token-${i}`,
      300,
      tempRoot,
    );
    await sharedStateManager.releaseSharedState(
      taskId,
      `token-${i}`,
      "failed",
      "Error",
      tempRoot,
    );
  }

  // Check retry eligibility
  const retryCheck = await sharedStateManager.shouldRetryTask(
    taskId,
    maxRetries,
    tempRoot,
  );
  expect(retryCheck.shouldRetry).toBe(false);
  expect(retryCheck.reason).toContain("max_retries_exceeded");
});
```

## Running Tests

### Run All Tests

```bash
# Using vitest directly
npm test

# Or run specific test suite
npx vitest run tests/shared-state-manager.test.mjs
npx vitest run tests/github-shared-state.test.mjs
npx vitest run tests/shared-state-integration.test.mjs

# Using test runner script
node run-shared-state-tests.mjs
```

### Run in Watch Mode

```bash
npx vitest watch tests/shared-state-manager.test.mjs
```

### Run with Coverage

```bash
npx vitest run --coverage
```

## Test Patterns

### Temporary Directory Setup

All tests use isolated temporary directories to avoid state contamination:

```javascript
let tempRoot = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(resolve(tmpdir(), "shared-state-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
```

### Mocking GitHub CLI

GitHub adapter tests mock the `gh` CLI using vitest:

```javascript
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function mockGh(stdout, stderr = "") {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(null, { stdout, stderr });
  });
}
```

### Testing Staleness

Tests use short TTLs and controlled delays:

```javascript
// Claim with 1 second TTL
await claimTaskInSharedState(taskId, ownerId, token, 1, tempRoot);

// Wait for staleness
await new Promise((resolve) => setTimeout(resolve, 1500));

// Verify stale detection
const result = await sweepStaleSharedStates(1000, tempRoot);
expect(result.sweptCount).toBe(1);
```

## Edge Cases Tested

### Concurrency

- Multiple agents claiming same task simultaneously
- Race condition between claim and heartbeat renewal
- Overlapping sweep operations

### Corruption

- Invalid JSON in registry file
- Missing required fields in state objects
- Malformed GitHub comment structure
- Registry backup on corruption detection

### Timing

- Heartbeat staleness detection with sub-second precision
- TTL enforcement across timezone boundaries
- Event log timestamp ordering

### Error Recovery

- GitHub API failures (network, rate limits, auth)
- File system errors (permissions, disk full)
- Partial state updates (label updated but comment fails)

## Test Statistics

- **Total tests**: 80+
- **Shared state manager**: 35+ tests
- **GitHub integration**: 25+ tests
- **Integration scenarios**: 20+ tests
- **Coverage target**: >90% code coverage

## Assertions

Tests follow vitest assertion patterns:

```javascript
// Boolean checks
expect(result.success).toBe(true);

// Object structure
expect(result.state).toBeDefined();
expect(result.state.taskId).toBe("task-1");

// Array operations
expect(result.state.eventLog).toHaveLength(3);
expect(result.state.eventLog.map((e) => e.event)).toContain("claimed");

// Error cases
expect(result.success).toBe(false);
expect(result.reason).toContain("conflict");

// Async operations
await expect(
  adapter.persistSharedStateToIssue("invalid", state),
).rejects.toThrow("Invalid issue number");
```

## Debugging

### Enable verbose logging

```bash
DEBUG=openfleet:* npx vitest run tests/shared-state-manager.test.mjs
```

### Inspect registry state

```javascript
// In test
const registry = await loadRegistry(getRegistryPath(tempRoot));
console.log(JSON.stringify(registry, null, 2));
```

### Check mock call history

```javascript
// In test
console.log(execFileMock.mock.calls);
```

## CI Integration

Tests are designed to run in CI environments:

- No external dependencies (GitHub CLI mocked)
- Isolated temporary directories
- Deterministic timing (controlled delays)
- Clean up on success and failure

Add to CI workflow:

```yaml
- name: Run shared state tests
  run: |
    cd scripts/openfleet
    npm test -- shared-state-manager.test.mjs
    npm test -- github-shared-state.test.mjs
    npm test -- shared-state-integration.test.mjs
```

## Contributing

When adding new features to the shared state system:

1. Add unit tests in `shared-state-manager.test.mjs`
2. Add GitHub integration tests in `github-shared-state.test.mjs`
3. Add end-to-end scenarios in `shared-state-integration.test.mjs`
4. Follow existing test patterns (temp dirs, mocking, assertions)
5. Test both success and error cases
6. Include edge cases (staleness, corruption, conflicts)

## References

- [Shared State Integration Summary](../SHARED_STATE_INTEGRATION.md)
- [Kanban GitHub Enhancement](../KANBAN_GITHUB_ENHANCEMENT.md)
- [GitHub Adapter Quick Reference](../GITHUB_ADAPTER_QUICK_REF.md)
- [Vitest Documentation](https://vitest.dev/)
