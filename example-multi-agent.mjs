#!/usr/bin/env node

/**
 * Example: Multi-Agent Task Coordination with GitHub Issues
 *
 * Demonstrates how to use the enhanced kanban-adapter for coordinating
 * multiple agents working on GitHub issues.
 */

import { randomUUID } from "node:crypto";
import {
  getKanbanAdapter,
  setKanbanBackend,
  persistSharedStateToIssue,
  readSharedStateFromIssue,
  markTaskIgnored,
  listTasks,
} from "./kanban-adapter.mjs";

// Configuration
const WORKSTATION_ID = process.env.WORKSTATION_ID || "workstation-local";
const AGENT_ID = process.env.AGENT_ID || "agent-" + randomUUID().slice(0, 8);
const OWNER_ID = `${WORKSTATION_ID}/${AGENT_ID}`;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

// Enable GitHub backend
setKanbanBackend("github");
const adapter = getKanbanAdapter();

console.log(`Agent ${AGENT_ID} on ${WORKSTATION_ID} starting...`);

/**
 * Try to claim a task by checking if it's available and persisting our state.
 */
async function claimTask(issueNumber) {
  console.log(`\n[${issueNumber}] Attempting to claim...`);

  // Check if already claimed
  const existingState = await readSharedStateFromIssue(issueNumber);

  if (existingState) {
    // Check if claim is stale
    const lastHeartbeat = new Date(existingState.heartbeat);
    const now = new Date();
    const timeSinceHeartbeat = now - lastHeartbeat;

    if (timeSinceHeartbeat < STALE_THRESHOLD) {
      console.log(
        `[${issueNumber}] Already claimed by ${existingState.ownerId}`,
      );
      return false;
    }

    console.log(
      `[${issueNumber}] Existing claim is stale (${Math.round(timeSinceHeartbeat / 1000)}s old), taking over...`,
    );
  }

  // Create our claim
  const claimState = {
    ownerId: OWNER_ID,
    attemptToken: randomUUID(),
    attemptStarted: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    status: "claimed",
    retryCount: existingState ? existingState.retryCount + 1 : 0,
  };

  const success = await persistSharedStateToIssue(issueNumber, claimState);

  if (success) {
    console.log(`[${issueNumber}] ✓ Claimed successfully`);
    return claimState;
  } else {
    console.log(`[${issueNumber}] ✗ Failed to claim`);
    return false;
  }
}

/**
 * Update task status to working and persist state.
 */
async function startWork(issueNumber, claimState) {
  console.log(`[${issueNumber}] Starting work...`);

  const workingState = {
    ...claimState,
    status: "working",
    heartbeat: new Date().toISOString(),
  };

  const success = await persistSharedStateToIssue(issueNumber, workingState);

  if (success) {
    console.log(`[${issueNumber}] ✓ Status updated to working`);
    return workingState;
  } else {
    console.log(`[${issueNumber}] ✗ Failed to update status`);
    return false;
  }
}

/**
 * Send heartbeat to keep claim alive.
 */
async function sendHeartbeat(issueNumber) {
  const currentState = await readSharedStateFromIssue(issueNumber);

  if (!currentState || currentState.ownerId !== OWNER_ID) {
    console.log(`[${issueNumber}] ⚠ Claim lost or taken by another agent`);
    return false;
  }

  const updatedState = {
    ...currentState,
    heartbeat: new Date().toISOString(),
  };

  const success = await persistSharedStateToIssue(issueNumber, updatedState);

  if (success) {
    console.log(`[${issueNumber}] 💓 Heartbeat sent`);
    return true;
  } else {
    console.log(`[${issueNumber}] ⚠ Heartbeat failed`);
    return false;
  }
}

/**
 * Find available tasks (not claimed, not ignored).
 */
async function findAvailableTasks() {
  console.log("\nFetching tasks...");

  const projectId = "owner/repo";
  const tasks = await listTasks(projectId, { status: "todo" });

  console.log(`Found ${tasks.length} total tasks`);

  const available = tasks.filter((t) => {
    // Skip if explicitly ignored
    if (t.meta.codex?.isIgnored) {
      return false;
    }

    // Skip if claimed by someone else recently
    if (t.meta.sharedState) {
      const lastHeartbeat = new Date(t.meta.sharedState.heartbeat);
      const now = new Date();
      const timeSinceHeartbeat = now - lastHeartbeat;

      if (timeSinceHeartbeat < STALE_THRESHOLD) {
        return false; // Still actively claimed
      }
    }

    return true;
  });

  console.log(`${available.length} tasks available for claiming`);

  return available;
}

/**
 * Example workflow: Find a task, claim it, work on it.
 */
async function exampleWorkflow() {
  try {
    // 1. Find available tasks
    const availableTasks = await findAvailableTasks();

    if (availableTasks.length === 0) {
      console.log("\nNo available tasks found");
      return;
    }

    // 2. Claim the first available task
    const task = availableTasks[0];
    console.log(`\nSelected task #${task.id}: ${task.title}`);

    const claimState = await claimTask(task.id);
    if (!claimState) {
      console.log("Failed to claim task");
      return;
    }

    // 3. Update to working status
    const workingState = await startWork(task.id, claimState);
    if (!workingState) {
      console.log("Failed to start work");
      return;
    }

    // 4. Simulate work with periodic heartbeats
    console.log(`\nSimulating work for 60 seconds with heartbeats...`);
    const heartbeatTimer = setInterval(() => {
      sendHeartbeat(task.id);
    }, HEARTBEAT_INTERVAL);

    setTimeout(() => {
      clearInterval(heartbeatTimer);
      console.log(`\n✓ Work simulation complete`);
      console.log(
        `\nIn real usage, you would now update task status and clean up state.`,
      );
    }, 60000);
  } catch (err) {
    console.error("Error in workflow:", err);
  }
}

/**
 * Example: Mark certain tasks as ignored.
 */
async function exampleIgnoreManagement() {
  console.log("\n=== Ignore Management Example ===");

  const projectId = "owner/repo";
  const tasks = await listTasks(projectId);

  // Find tasks that should be ignored (example criteria)
  const securityTasks = tasks.filter(
    (t) =>
      t.title.toLowerCase().includes("security") ||
      t.title.toLowerCase().includes("audit"),
  );

  console.log(`Found ${securityTasks.length} security-related tasks`);

  for (const task of securityTasks.slice(0, 2)) {
    // Limit to 2 for demo
    console.log(`\nMarking task #${task.id} as ignored...`);
    const success = await markTaskIgnored(
      task.id,
      "Security tasks require manual review",
    );
    if (success) {
      console.log(`✓ Task #${task.id} marked as ignored`);
    } else {
      console.log(`✗ Failed to mark task #${task.id} as ignored`);
    }
  }
}

/**
 * Example: Find and report stale claims.
 */
async function findStaleClaims() {
  console.log("\n=== Stale Claim Detection ===");

  const projectId = "owner/repo";
  const tasks = await listTasks(projectId);

  const staleTasks = tasks.filter((t) => {
    if (!t.meta.sharedState) return false;

    const lastHeartbeat = new Date(t.meta.sharedState.heartbeat);
    const now = new Date();
    const timeSinceHeartbeat = now - lastHeartbeat;

    return timeSinceHeartbeat > STALE_THRESHOLD;
  });

  console.log(`Found ${staleTasks.length} tasks with stale claims:`);

  for (const task of staleTasks) {
    const state = task.meta.sharedState;
    const lastHeartbeat = new Date(state.heartbeat);
    const minutesStale = Math.round((Date.now() - lastHeartbeat) / 1000 / 60);

    console.log(`
  Task #${task.id}: ${task.title}
  Claimed by: ${state.ownerId}
  Last heartbeat: ${minutesStale} minutes ago
  Status: ${state.status}
  Retry count: ${state.retryCount}
    `);
  }
}

// Main entry point
async function main() {
  const command = process.argv[2] || "workflow";

  switch (command) {
    case "workflow":
      await exampleWorkflow();
      break;
    case "ignore":
      await exampleIgnoreManagement();
      break;
    case "stale":
      await findStaleClaims();
      break;
    case "list":
      await findAvailableTasks();
      break;
    default:
      console.log(`
Usage: node example-multi-agent.mjs [command]

Commands:
  workflow  - Run full claim and work simulation (default)
  ignore    - Mark security tasks as ignored
  stale     - Find and report stale claims
  list      - List available tasks

Environment variables:
  WORKSTATION_ID - Workstation identifier (default: workstation-local)
  AGENT_ID       - Agent identifier (default: agent-<random>)
      `);
  }
}

// Only run if executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

export {
  claimTask,
  startWork,
  sendHeartbeat,
  findAvailableTasks,
  findStaleClaims,
};
