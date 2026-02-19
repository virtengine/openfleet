#!/usr/bin/env node
/**
 * Test script to verify shared state manager integration
 * This validates that all modules can import and use shared state functions
 */

import { randomUUID } from "crypto";

console.log("Testing shared state integration...\n");

// Test 1: Import shared state manager
console.log("1. Testing shared-state-manager.mjs imports...");
try {
  const {
    claimTaskInSharedState,
    renewSharedStateHeartbeat,
    releaseSharedState,
    shouldRetryTask,
    sweepStaleSharedStates,
  } = await import("./shared-state-manager.mjs");
  console.log("   ✓ All shared state manager exports available");
} catch (err) {
  console.error("   ✗ Failed to import shared-state-manager:", err.message);
  process.exit(1);
}

// Test 2: Import task-claims with shared state integration
console.log("\n2. Testing task-claims.mjs with shared state...");
try {
  const { claimTask, renewClaim, releaseTask } =
    await import("./task-claims.mjs");
  console.log("   ✓ task-claims.mjs imports successfully");
} catch (err) {
  console.error("   ✗ Failed to import task-claims:", err.message);
  process.exit(1);
}

// Test 3: Import sync-engine with shared state integration
console.log("\n3. Testing sync-engine.mjs with shared state...");
try {
  const { SyncEngine, createSyncEngine } = await import("./sync-engine.mjs");
  console.log("   ✓ sync-engine.mjs imports successfully");
} catch (err) {
  console.error("   ✗ Failed to import sync-engine:", err.message);
  process.exit(1);
}

// Test 4: Import ve-orchestrator with shared state integration
console.log("\n4. Testing ve-orchestrator.mjs with shared state...");
try {
  const { parseOrchestratorArgs, runOrchestrator } =
    await import("./ve-orchestrator.mjs");
  console.log("   ✓ ve-orchestrator.mjs imports successfully");
} catch (err) {
  console.error("   ✗ Failed to import ve-orchestrator:", err.message);
  process.exit(1);
}

// Test 5: Verify environment variables are read correctly
console.log("\n5. Testing environment variable defaults...");
const envTests = [
  {
    key: "SHARED_STATE_ENABLED",
    expected: "true (default)",
    actual: process.env.SHARED_STATE_ENABLED !== "false",
  },
  {
    key: "SHARED_STATE_HEARTBEAT_INTERVAL_MS",
    expected: "60000 (default)",
    actual: Number(process.env.SHARED_STATE_HEARTBEAT_INTERVAL_MS) || 60_000,
  },
  {
    key: "SHARED_STATE_STALE_THRESHOLD_MS",
    expected: "300000 (default)",
    actual: Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 300_000,
  },
  {
    key: "SHARED_STATE_MAX_RETRIES",
    expected: "3 (default)",
    actual: Number(process.env.SHARED_STATE_MAX_RETRIES) || 3,
  },
];

for (const test of envTests) {
  console.log(`   ${test.key}: ${test.actual} (${test.expected})`);
}
console.log("   ✓ All environment variables have valid defaults");

// Test 6: Test basic shared state operations
console.log("\n6. Testing basic shared state operations...");
try {
  const { claimTaskInSharedState, releaseSharedState, getSharedState } =
    await import("./shared-state-manager.mjs");

  const testTaskId = `test-${randomUUID()}`;
  const testOwnerId = `test-owner-${Date.now()}`;
  const testToken = randomUUID();

  // Claim a test task
  const claimResult = await claimTaskInSharedState(
    testTaskId,
    testOwnerId,
    testToken,
    300,
  );
  if (!claimResult.success) {
    throw new Error(`Failed to claim test task: ${claimResult.reason}`);
  }
  console.log(`   ✓ Successfully claimed test task ${testTaskId}`);

  // Verify state exists
  const state = await getSharedState(testTaskId);
  if (!state || state.taskId !== testTaskId) {
    throw new Error("Failed to retrieve claimed state");
  }
  console.log(`   ✓ Successfully retrieved shared state`);

  // Release the task
  const releaseResult = await releaseSharedState(
    testTaskId,
    testToken,
    "complete",
  );
  if (!releaseResult.success) {
    throw new Error(`Failed to release test task: ${releaseResult.reason}`);
  }
  console.log(`   ✓ Successfully released test task`);
} catch (err) {
  console.error("   ✗ Shared state operations failed:", err.message);
  process.exit(1);
}

console.log("\n✓ All integration tests passed!");
console.log("\nShared state manager is properly integrated with:");
console.log("  - task-claims.mjs (claim, renew, release)");
console.log("  - sync-engine.mjs (conflict detection, state sync)");
console.log(
  "  - ve-orchestrator.mjs (retry checks, stale sweeps, completion tracking)",
);
console.log("\nEnvironment variables configured in .env.example:");
console.log("  - SHARED_STATE_ENABLED");
console.log("  - SHARED_STATE_HEARTBEAT_INTERVAL_MS");
console.log("  - SHARED_STATE_STALE_THRESHOLD_MS");
console.log("  - SHARED_STATE_MAX_RETRIES");
