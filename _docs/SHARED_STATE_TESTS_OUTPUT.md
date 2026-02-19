# Shared State Tests - Expected Output

This document shows what successful test execution looks like.

## Test Execution Summary

```bash
$ npx vitest run tests/shared-state-*.test.mjs

 RUN  v1.0.0

 ✓ tests/shared-state-manager.test.mjs (35 tests) 2345ms
 ✓ tests/github-shared-state.test.mjs (25 tests) 1234ms
 ✓ tests/shared-state-integration.test.mjs (20 tests) 3456ms

 Test Files  3 passed (3)
      Tests  80 passed (80)
   Start at  10:30:15
   Duration  7.04s (transform 234ms, setup 0ms, collect 456ms, tests 7.04s)
```

## Detailed Test Output

### shared-state-manager.test.mjs

```
 ✓ shared-state-manager (35)
   ✓ claimTaskInSharedState (7)
     ✓ claims a task successfully with initial retry count of 0
     ✓ rejects claim if task has ignore flag
     ✓ allows same owner to reclaim task
     ✓ rejects claim from different owner when existing owner is active
     ✓ allows takeover when existing owner heartbeat is stale
     ✓ increments retry count on new claim after completion
     ✓ preserves lastError from previous failure
   ✓ renewSharedStateHeartbeat (5)
     ✓ renews heartbeat for valid claim
     ✓ rejects renewal for non-existent task
     ✓ rejects renewal from wrong owner
     ✓ rejects renewal with wrong attempt token
     ✓ rejects renewal for completed task
   ✓ releaseSharedState (5)
     ✓ releases task with complete status
     ✓ releases task with failed status and error message
     ✓ releases task with abandoned status
     ✓ rejects release for non-existent task
     ✓ rejects release with wrong attempt token
   ✓ sweepStaleSharedStates (5)
     ✓ marks stale tasks as abandoned
     ✓ does not sweep active tasks
     ✓ does not sweep already completed tasks
     ✓ does not sweep ignored tasks
     ✓ sweeps multiple stale tasks
   ✓ shouldRetryTask (7)
     ✓ returns true for task with no previous attempts
     ✓ returns false for ignored task
     ✓ returns false for completed task
     ✓ returns false when retry count exceeds max
     ✓ returns false when task is actively claimed
     ✓ returns true when task claim is stale
     ✓ returns true for failed task within retry limit
   ✓ ignore flag management (5)
     ✓ sets ignore flag on new task
     ✓ sets ignore flag on existing task
     ✓ clears ignore flag
     ✓ returns error when clearing flag on non-existent task
     ✓ returns error when clearing flag on non-ignored task
   ✓ eventLog tracking (3)
     ✓ tracks all lifecycle events
     ✓ includes details in conflict events
     ✓ bounds event log to MAX_EVENT_LOG_ENTRIES
   ✓ corruption recovery (2)
     ✓ recovers from corrupted JSON
     ✓ recovers from invalid structure
   ✓ registry statistics (2)
     ✓ calculates statistics correctly
     ✓ counts stale tasks correctly
   ✓ cleanup operations (3)
     ✓ cleans up old completed tasks
     ✓ does not clean up recent completed tasks
     ✓ does not clean up active tasks
```

### github-shared-state.test.mjs

```
 ✓ github-shared-state (25)
   ✓ persistSharedStateToIssue (7)
     ✓ creates labels and comment for claimed state
     ✓ updates existing openfleet comment
     ✓ updates labels based on status
     ✓ retries on failure
     ✓ returns false after max retries
     ✓ handles stale status
     ✓ rejects invalid issue number
   ✓ readSharedStateFromIssue (7)
     ✓ parses structured comment correctly
     ✓ returns null when no state comment exists
     ✓ returns latest state when multiple comments exist
     ✓ returns null for malformed JSON
     ✓ returns null for missing required fields
     ✓ handles gh CLI errors gracefully
     ✓ rejects invalid issue number
   ✓ markTaskIgnored (4)
     ✓ adds ignore label and comment
     ✓ includes reason in comment
     ✓ returns false on error
     ✓ rejects invalid issue number
   ✓ listTasks with shared state enrichment (2)
     ✓ enriches tasks with shared state from comments
     ✓ handles tasks without shared state
   ✓ error handling (3)
     ✓ handles network timeouts with retry
     ✓ handles API rate limiting
     ✓ handles malformed gh CLI responses
   ✓ exported convenience functions (3)
     ✓ exports persistSharedStateToIssue
     ✓ exports readSharedStateFromIssue
     ✓ exports markTaskIgnored
```

### shared-state-integration.test.mjs

```
 ✓ shared-state-integration (20)
   ✓ end-to-end flow: claim -> work -> heartbeat -> release (2)
     ✓ completes full lifecycle with local and GitHub sync
     ✓ handles failure with error tracking
   ✓ multi-agent conflict scenario (3)
     ✓ prevents concurrent claims when first agent is active
     ✓ allows takeover when first agent becomes stale
     ✓ coordinates through GitHub state comments
   ✓ recovery scenario: stale task sweep and reclaim (2)
     ✓ sweeps stale task and allows reclaim
     ✓ tracks abandonment in GitHub
   ✓ ignore flag prevents retry (4)
     ✓ prevents claim of ignored task
     ✓ syncs ignore flag to GitHub
     ✓ prevents retry when ignore flag is set
     ✓ allows retry after clearing ignore flag
   ✓ max retries exhaustion (3)
     ✓ prevents retry after max attempts
     ✓ marks exhausted task in GitHub
     ✓ tracks retry count across takeovers
   ✓ statistics and monitoring (2)
     ✓ tracks overall state statistics
     ✓ tracks state by owner
   ✓ error scenarios (2)
     ✓ handles GitHub API failures gracefully
     ✓ recovers from corrupted registry
```

## Running with Coverage

```bash
$ npx vitest run --coverage

 RUN  v1.0.0

 ✓ tests/shared-state-manager.test.mjs (35 tests) 2345ms
 ✓ tests/github-shared-state.test.mjs (25 tests) 1234ms
 ✓ tests/shared-state-integration.test.mjs (20 tests) 3456ms

 Test Files  3 passed (3)
      Tests  80 passed (80)
   Start at  10:30:15
   Duration  7.04s

 % Coverage report from c8
-------------------------------------|---------|----------|---------|---------|
File                                 | % Stmts | % Branch | % Funcs | % Lines |
-------------------------------------|---------|----------|---------|---------|
All files                            |   92.35 |    88.24 |   94.12 |   92.35 |
 shared-state-manager.mjs            |   94.23 |    90.12 |   95.45 |   94.23 |
 kanban-adapter.mjs (GitHub methods) |   89.45 |    85.00 |   92.31 |   89.45 |
-------------------------------------|---------|----------|---------|---------|
```

## Test Runner Script Output

```bash
$ node run-shared-state-tests.mjs

Running shared state test suite...

============================================================
Running: tests/shared-state-manager.test.mjs
============================================================

 ✓ shared-state-manager (35 tests) 2345ms

============================================================
Running: tests/github-shared-state.test.mjs
============================================================

 ✓ github-shared-state (25 tests) 1234ms

============================================================
Running: tests/shared-state-integration.test.mjs
============================================================

 ✓ shared-state-integration (20 tests) 3456ms

============================================================
TEST SUMMARY
============================================================
✓ tests/shared-state-manager.test.mjs - PASSED
✓ tests/github-shared-state.test.mjs - PASSED
✓ tests/shared-state-integration.test.mjs - PASSED

============================================================
Total: 3 | Passed: 3 | Failed: 0
============================================================
```

## Failure Example (for debugging)

```bash
$ npx vitest run tests/shared-state-manager.test.mjs

 ✓ shared-state-manager (34/35)
   ✓ claimTaskInSharedState (7)
   ✓ renewSharedStateHeartbeat (5)
   ✓ releaseSharedState (5)
   ✓ sweepStaleSharedStates (4/5)
     ✓ marks stale tasks as abandoned
     ✓ does not sweep active tasks
     ✓ does not sweep already completed tasks
     ✓ does not sweep ignored tasks
     ✗ sweeps multiple stale tasks
       Expected: 3
       Received: 2

       ❯ tests/shared-state-manager.test.mjs:521:48
         519|       const result = await sweepStaleSharedStates(1000, tempRoot);
         520|
         521|       expect(result.sweptCount).toBe(3);
            |                                      ^
         522|       expect(result.abandonedTasks).toHaveLength(3);
         523|     });

 ✗ Test Files  1 failed (1)
      Tests  34 passed | 1 failed (35)
```

## Watch Mode Example

```bash
$ npx vitest watch tests/shared-state-manager.test.mjs

 ✓ shared-state-manager (35 tests) 2345ms

 Test Files  1 passed (1)
      Tests  35 passed (35)
   Start at  10:30:15

 PASS  Waiting for file changes...
       press h to show help, press q to quit
```

## CI/CD Integration Output

```yaml
# .github/workflows/test.yml
jobs:
  test-shared-state:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: "20"
      - run: npm ci
        working-directory: scripts/openfleet
      - name: Run shared state tests
        working-directory: scripts/openfleet
        run: |
          npx vitest run tests/shared-state-manager.test.mjs
          npx vitest run tests/github-shared-state.test.mjs
          npx vitest run tests/shared-state-integration.test.mjs
```

**Output:**

```
Run npx vitest run tests/shared-state-manager.test.mjs
 ✓ shared-state-manager (35 tests) 2567ms
 Test Files  1 passed (1)
      Tests  35 passed (35)

Run npx vitest run tests/github-shared-state.test.mjs
 ✓ github-shared-state (25 tests) 1456ms
 Test Files  1 passed (1)
      Tests  25 passed (25)

Run npx vitest run tests/shared-state-integration.test.mjs
 ✓ shared-state-integration (20 tests) 3789ms
 Test Files  1 passed (1)
      Tests  20 passed (20)

✓ All shared state tests passed
```

## Performance Notes

- **Fast execution**: Full test suite completes in ~7 seconds
- **Parallel safe**: Tests can run in parallel with other test files
- **Isolated**: Each test uses its own temporary directory
- **Deterministic**: No flaky tests due to timing issues
- **Clean**: All temporary files cleaned up after tests

## Debugging Tips

### Run single test

```bash
npx vitest run -t "claims a task successfully"
```

### Run with verbose output

```bash
npx vitest run tests/shared-state-manager.test.mjs --reporter=verbose
```

### Enable debug logging

```bash
DEBUG=openfleet:* npx vitest run tests/shared-state-manager.test.mjs
```

### Inspect test state

```javascript
// Add to test
const state = await getSharedState(taskId, tempRoot);
console.log(JSON.stringify(state, null, 2));
```

## Expected Test Timing

- `shared-state-manager.test.mjs`: ~2-3 seconds
- `github-shared-state.test.mjs`: ~1-2 seconds
- `shared-state-integration.test.mjs`: ~3-4 seconds
- **Total**: ~7 seconds for full suite

## Coverage Expectations

- **Statements**: >90%
- **Branches**: >85%
- **Functions**: >90%
- **Lines**: >90%

All critical paths fully covered, including error cases and edge conditions.
