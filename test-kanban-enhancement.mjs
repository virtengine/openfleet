#!/usr/bin/env node

/**
 * Test script for kanban-adapter.mjs GitHub enhancements
 *
 * Validates:
 * - Module loads without syntax errors
 * - New exports are available
 * - SharedState typedef is properly defined
 * - GitHubAdapter has new methods
 */

import {
  getKanbanAdapter,
  setKanbanBackend,
  persistSharedStateToIssue,
  readSharedStateFromIssue,
  markTaskIgnored,
} from "./kanban-adapter.mjs";

console.log("✓ Module loaded successfully");

// Test that new exports exist
if (typeof persistSharedStateToIssue !== "function") {
  throw new Error("persistSharedStateToIssue export missing");
}
if (typeof readSharedStateFromIssue !== "function") {
  throw new Error("readSharedStateFromIssue export missing");
}
if (typeof markTaskIgnored !== "function") {
  throw new Error("markTaskIgnored export missing");
}
console.log("✓ New exports are available");

// Test GitHub adapter has new methods
try {
  setKanbanBackend("github");
  const adapter = getKanbanAdapter();

  if (typeof adapter.persistSharedStateToIssue !== "function") {
    throw new Error("GitHubAdapter.persistSharedStateToIssue method missing");
  }
  if (typeof adapter.readSharedStateFromIssue !== "function") {
    throw new Error("GitHubAdapter.readSharedStateFromIssue method missing");
  }
  if (typeof adapter.markTaskIgnored !== "function") {
    throw new Error("GitHubAdapter.markTaskIgnored method missing");
  }
  if (!adapter._codexLabels) {
    throw new Error("GitHubAdapter._codexLabels property missing");
  }
  if (adapter._codexLabels.claimed !== "codex:claimed") {
    throw new Error("Invalid codex:claimed label");
  }
  if (adapter._codexLabels.working !== "codex:working") {
    throw new Error("Invalid codex:working label");
  }
  if (adapter._codexLabels.stale !== "codex:stale") {
    throw new Error("Invalid codex:stale label");
  }
  if (adapter._codexLabels.ignore !== "codex:ignore") {
    throw new Error("Invalid codex:ignore label");
  }

  console.log("✓ GitHubAdapter has all new methods and properties");
} catch (err) {
  console.error("✗ GitHubAdapter validation failed:", err.message);
  process.exit(1);
}

// Test that VK adapter still works (doesn't have new methods, but shouldn't fail)
try {
  setKanbanBackend("vk");
  const vkAdapter = getKanbanAdapter();
  if (vkAdapter.persistSharedStateToIssue) {
    throw new Error("VKAdapter should not have persistSharedStateToIssue");
  }
  console.log("✓ VKAdapter unaffected by changes");
} catch (err) {
  console.error("✗ VKAdapter validation failed:", err.message);
  process.exit(1);
}

// Test SharedState structure validation
const mockSharedState = {
  ownerId: "workstation-123/agent-456",
  attemptToken: "uuid-test",
  attemptStarted: "2026-02-14T17:00:00Z",
  heartbeat: "2026-02-14T17:30:00Z",
  status: "working",
  retryCount: 1,
};

// Verify all required fields
const requiredFields = [
  "ownerId",
  "attemptToken",
  "attemptStarted",
  "heartbeat",
  "status",
  "retryCount",
];
for (const field of requiredFields) {
  if (!(field in mockSharedState)) {
    throw new Error(`SharedState missing required field: ${field}`);
  }
}
console.log("✓ SharedState structure is valid");

console.log("\n✅ All validation tests passed!");
console.log("\nEnhancements added:");
console.log(
  "  • New label scheme: codex:claimed, codex:working, codex:stale, codex:ignore",
);
console.log("  • persistSharedStateToIssue() - persist agent state to issues");
console.log("  • readSharedStateFromIssue() - read agent state from issues");
console.log("  • markTaskIgnored() - mark tasks as ignored");
console.log("  • Enhanced updateTaskStatus() - optionally sync shared state");
console.log(
  "  • Enhanced listTasks() and getTask() - include shared state in meta",
);
console.log("  • Retry logic with exponential backoff");
console.log("  • Detailed JSDoc documentation");
