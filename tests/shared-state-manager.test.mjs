import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

describe("shared-state-manager", () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "shared-state-test-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  describe("claimTaskInSharedState", () => {
    let claimTaskInSharedState;

    beforeEach(async () => {
      ({ claimTaskInSharedState } =
        await import("../shared-state-manager.mjs"));
    });

    it("claims a task successfully with initial retry count of 0", async () => {
      const result = await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.state.taskId).toBe("task-1");
      expect(result.state.ownerId).toBe("workstation-1/agent-1");
      expect(result.state.attemptToken).toBe("token-123");
      expect(result.state.attemptStatus).toBe("claimed");
      expect(result.state.retryCount).toBe(0);
      expect(result.state.ownerHeartbeat).toBeTruthy();
      expect(result.state.eventLog).toHaveLength(1);
      expect(result.state.eventLog[0].event).toBe("claimed");
    });

    it("rejects claim if task has ignore flag", async () => {
      const { setIgnoreFlag } = await import("../shared-state-manager.mjs");
      await setIgnoreFlag("task-ignored", "human_created", tempRoot);

      const result = await claimTaskInSharedState(
        "task-ignored",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toContain("task_ignored");
      expect(result.reason).toContain("human_created");
    });

    it("allows same owner to reclaim task", async () => {
      const firstResult = await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      expect(firstResult.success).toBe(true);

      const secondResult = await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-456",
        300,
        tempRoot,
      );

      expect(secondResult.success).toBe(true);
      expect(secondResult.state.attemptToken).toBe("token-456");
      expect(secondResult.state.eventLog).toHaveLength(2);
      expect(secondResult.state.eventLog[1].event).toBe("reclaimed");
    });

    it("rejects claim from different owner when existing owner is active", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await claimTaskInSharedState(
        "task-1",
        "workstation-2/agent-2",
        "token-456",
        300,
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toContain("conflict");
      expect(result.reason).toContain("existing_owner_active");
      expect(result.state).toBeDefined();
      expect(result.state.ownerId).toBe("workstation-1/agent-1");
    });

    it("allows takeover when existing owner heartbeat is stale", async () => {
      // First claim
      await claimTaskInSharedState(
        "task-stale",
        "workstation-1/agent-1",
        "token-123",
        1, // 1 second TTL
        tempRoot,
      );

      // Wait for heartbeat to become stale
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Second claim should succeed
      const result = await claimTaskInSharedState(
        "task-stale",
        "workstation-2/agent-2",
        "token-456",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);
      expect(result.state.ownerId).toBe("workstation-2/agent-2");
      expect(result.state.attemptToken).toBe("token-456");
      expect(result.state.retryCount).toBe(1);
      expect(result.state.eventLog.some((e) => e.event === "conflict")).toBe(
        true,
      );
      expect(
        result.state.eventLog.find((e) => e.event === "conflict").details,
      ).toContain("takeover");
    });

    it("increments retry count on new claim after completion", async () => {
      const { releaseSharedState } =
        await import("../shared-state-manager.mjs");

      // First attempt
      await claimTaskInSharedState(
        "task-retry",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-retry",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      // Second attempt
      const result = await claimTaskInSharedState(
        "task-retry",
        "workstation-2/agent-2",
        "token-456",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);
      expect(result.state.retryCount).toBe(1);
    });

    it("preserves lastError from previous failure", async () => {
      const { releaseSharedState } =
        await import("../shared-state-manager.mjs");

      await claimTaskInSharedState(
        "task-error",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-error",
        "token-123",
        "failed",
        "Connection timeout",
        tempRoot,
      );

      const result = await claimTaskInSharedState(
        "task-error",
        "workstation-2/agent-2",
        "token-456",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);
      expect(result.state.lastError).toBe("Connection timeout");
      expect(result.state.retryCount).toBe(1);
    });
  });

  describe("renewSharedStateHeartbeat", () => {
    let claimTaskInSharedState, renewSharedStateHeartbeat;

    beforeEach(async () => {
      ({ claimTaskInSharedState, renewSharedStateHeartbeat } =
        await import("../shared-state-manager.mjs"));
    });

    it("renews heartbeat for valid claim", async () => {
      const claimResult = await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      const originalHeartbeat = claimResult.state.ownerHeartbeat;

      await new Promise((resolve) => setTimeout(resolve, 100));

      const renewResult = await renewSharedStateHeartbeat(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        tempRoot,
      );

      expect(renewResult.success).toBe(true);

      const { getSharedState } = await import("../shared-state-manager.mjs");
      const state = await getSharedState("task-1", tempRoot);
      expect(state.ownerHeartbeat).not.toBe(originalHeartbeat);
      expect(state.attemptStatus).toBe("working");
      expect(state.eventLog.some((e) => e.event === "renewed")).toBe(true);
    });

    it("rejects renewal for non-existent task", async () => {
      const result = await renewSharedStateHeartbeat(
        "nonexistent",
        "workstation-1/agent-1",
        "token-123",
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("task_not_found");
    });

    it("rejects renewal from wrong owner", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await renewSharedStateHeartbeat(
        "task-1",
        "workstation-2/agent-2",
        "token-123",
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("owner_mismatch");
    });

    it("rejects renewal with wrong attempt token", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await renewSharedStateHeartbeat(
        "task-1",
        "workstation-1/agent-1",
        "wrong-token",
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("attempt_token_mismatch");
    });

    it("rejects renewal for completed task", async () => {
      const { releaseSharedState } =
        await import("../shared-state-manager.mjs");

      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-1",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      const result = await renewSharedStateHeartbeat(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("task_already_complete");
    });
  });

  describe("releaseSharedState", () => {
    let claimTaskInSharedState, releaseSharedState, getSharedState;

    beforeEach(async () => {
      ({ claimTaskInSharedState, releaseSharedState, getSharedState } =
        await import("../shared-state-manager.mjs"));
    });

    it("releases task with complete status", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await releaseSharedState(
        "task-1",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      expect(result.success).toBe(true);

      const state = await getSharedState("task-1", tempRoot);
      expect(state.attemptStatus).toBe("complete");
      expect(state.eventLog.some((e) => e.event === "released")).toBe(true);
    });

    it("releases task with failed status and error message", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await releaseSharedState(
        "task-1",
        "token-123",
        "failed",
        "Build failed",
        tempRoot,
      );

      expect(result.success).toBe(true);

      const state = await getSharedState("task-1", tempRoot);
      expect(state.attemptStatus).toBe("failed");
      expect(state.lastError).toBe("Build failed");
    });

    it("releases task with abandoned status", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await releaseSharedState(
        "task-1",
        "token-123",
        "abandoned",
        undefined,
        tempRoot,
      );

      expect(result.success).toBe(true);

      const state = await getSharedState("task-1", tempRoot);
      expect(state.attemptStatus).toBe("abandoned");
    });

    it("rejects release for non-existent task", async () => {
      const result = await releaseSharedState(
        "nonexistent",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("task_not_found");
    });

    it("rejects release with wrong attempt token", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await releaseSharedState(
        "task-1",
        "wrong-token",
        "complete",
        undefined,
        tempRoot,
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("attempt_token_mismatch");
    });
  });

  describe("sweepStaleSharedStates", () => {
    let claimTaskInSharedState, sweepStaleSharedStates, getSharedState;

    beforeEach(async () => {
      ({ claimTaskInSharedState, sweepStaleSharedStates, getSharedState } =
        await import("../shared-state-manager.mjs"));
    });

    it("marks stale tasks as abandoned", async () => {
      await claimTaskInSharedState(
        "task-stale",
        "workstation-1/agent-1",
        "token-123",
        1,
        tempRoot,
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const result = await sweepStaleSharedStates(1000, tempRoot);

      expect(result.sweptCount).toBe(1);
      expect(result.abandonedTasks).toContain("task-stale");

      const state = await getSharedState("task-stale", tempRoot);
      expect(state.attemptStatus).toBe("abandoned");
      expect(state.lastError).toContain("Heartbeat stale");
      expect(state.eventLog.some((e) => e.event === "abandoned")).toBe(true);
    });

    it("does not sweep active tasks", async () => {
      await claimTaskInSharedState(
        "task-active",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await sweepStaleSharedStates(300000, tempRoot);

      expect(result.sweptCount).toBe(0);
      expect(result.abandonedTasks).toHaveLength(0);
    });

    it("does not sweep already completed tasks", async () => {
      const { releaseSharedState } =
        await import("../shared-state-manager.mjs");

      await claimTaskInSharedState(
        "task-complete",
        "workstation-1/agent-1",
        "token-123",
        1,
        tempRoot,
      );
      await releaseSharedState(
        "task-complete",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const result = await sweepStaleSharedStates(1000, tempRoot);

      expect(result.sweptCount).toBe(0);
    });

    it("does not sweep ignored tasks", async () => {
      const { setIgnoreFlag } = await import("../shared-state-manager.mjs");

      await claimTaskInSharedState(
        "task-ignored",
        "workstation-1/agent-1",
        "token-123",
        1,
        tempRoot,
      );
      await setIgnoreFlag("task-ignored", "human_created", tempRoot);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const result = await sweepStaleSharedStates(1000, tempRoot);

      expect(result.sweptCount).toBe(0);
    });

    it("sweeps multiple stale tasks", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-1",
        1,
        tempRoot,
      );
      await claimTaskInSharedState(
        "task-2",
        "workstation-1/agent-1",
        "token-2",
        1,
        tempRoot,
      );
      await claimTaskInSharedState(
        "task-3",
        "workstation-1/agent-1",
        "token-3",
        1,
        tempRoot,
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const result = await sweepStaleSharedStates(1000, tempRoot);

      expect(result.sweptCount).toBe(3);
      expect(result.abandonedTasks).toHaveLength(3);
    });
  });

  describe("shouldRetryTask", () => {
    let claimTaskInSharedState,
      releaseSharedState,
      setIgnoreFlag,
      shouldRetryTask;

    beforeEach(async () => {
      ({
        claimTaskInSharedState,
        releaseSharedState,
        setIgnoreFlag,
        shouldRetryTask,
      } = await import("../shared-state-manager.mjs"));
    });

    it("returns true for task with no previous attempts", async () => {
      const result = await shouldRetryTask("new-task", 3, tempRoot);

      expect(result.shouldRetry).toBe(true);
      expect(result.reason).toBe("no_previous_attempts");
    });

    it("returns false for ignored task", async () => {
      await setIgnoreFlag("task-ignored", "human_created", tempRoot);

      const result = await shouldRetryTask("task-ignored", 3, tempRoot);

      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toContain("ignored");
      expect(result.reason).toContain("human_created");
    });

    it("returns false for completed task", async () => {
      await claimTaskInSharedState(
        "task-complete",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-complete",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      const result = await shouldRetryTask("task-complete", 3, tempRoot);

      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toBe("already_complete");
    });

    it("returns false when retry count exceeds max", async () => {
      // Simulate 4 attempts
      for (let i = 0; i < 4; i++) {
        await claimTaskInSharedState(
          "task-retry",
          `workstation-${i}/agent-${i}`,
          `token-${i}`,
          300,
          tempRoot,
        );
        await releaseSharedState(
          "task-retry",
          `token-${i}`,
          "failed",
          `Attempt ${i} failed`,
          tempRoot,
        );
      }

      const result = await shouldRetryTask("task-retry", 3, tempRoot);

      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toContain("max_retries_exceeded");
      expect(result.reason).toContain("3/3");
    });

    it("returns false when task is actively claimed", async () => {
      await claimTaskInSharedState(
        "task-active",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await shouldRetryTask("task-active", 3, tempRoot);

      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toBe("currently_owned_by_active_agent");
    });

    it("returns true when task claim is stale", async () => {
      await claimTaskInSharedState(
        "task-stale",
        "workstation-1/agent-1",
        "token-123",
        1,
        tempRoot,
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const result = await shouldRetryTask("task-stale", 3, tempRoot);

      expect(result.shouldRetry).toBe(true);
      expect(result.reason).toBe("eligible_for_retry");
    });

    it("returns true for failed task within retry limit", async () => {
      await claimTaskInSharedState(
        "task-retry",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-retry",
        "token-123",
        "failed",
        "Build error",
        tempRoot,
      );

      const result = await shouldRetryTask("task-retry", 3, tempRoot);

      expect(result.shouldRetry).toBe(true);
      expect(result.reason).toBe("eligible_for_retry");
    });
  });

  describe("ignore flag management", () => {
    let setIgnoreFlag, clearIgnoreFlag, getSharedState;

    beforeEach(async () => {
      ({ setIgnoreFlag, clearIgnoreFlag, getSharedState } =
        await import("../shared-state-manager.mjs"));
    });

    it("sets ignore flag on new task", async () => {
      const result = await setIgnoreFlag("task-new", "human_created", tempRoot);

      expect(result.success).toBe(true);

      const state = await getSharedState("task-new", tempRoot);
      expect(state.ignoreReason).toBe("human_created");
      expect(state.eventLog.some((e) => e.event === "ignored")).toBe(true);
    });

    it("sets ignore flag on existing task", async () => {
      const { claimTaskInSharedState } =
        await import("../shared-state-manager.mjs");

      await claimTaskInSharedState(
        "task-existing",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await setIgnoreFlag(
        "task-existing",
        "invalid_spec",
        tempRoot,
      );

      expect(result.success).toBe(true);

      const state = await getSharedState("task-existing", tempRoot);
      expect(state.ignoreReason).toBe("invalid_spec");
    });

    it("clears ignore flag", async () => {
      await setIgnoreFlag("task-ignored", "human_created", tempRoot);

      const result = await clearIgnoreFlag("task-ignored", tempRoot);

      expect(result.success).toBe(true);

      const state = await getSharedState("task-ignored", tempRoot);
      expect(state.ignoreReason).toBeUndefined();
      expect(state.eventLog.some((e) => e.event === "unignored")).toBe(true);
    });

    it("returns error when clearing flag on non-existent task", async () => {
      const result = await clearIgnoreFlag("nonexistent", tempRoot);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("task_not_found");
    });

    it("returns error when clearing flag on non-ignored task", async () => {
      const { claimTaskInSharedState } =
        await import("../shared-state-manager.mjs");

      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await clearIgnoreFlag("task-1", tempRoot);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("not_ignored");
    });
  });

  describe("eventLog tracking", () => {
    let claimTaskInSharedState,
      renewSharedStateHeartbeat,
      releaseSharedState,
      getSharedState;

    beforeEach(async () => {
      ({
        claimTaskInSharedState,
        renewSharedStateHeartbeat,
        releaseSharedState,
        getSharedState,
      } = await import("../shared-state-manager.mjs"));
    });

    it("tracks all lifecycle events", async () => {
      // Claim
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      // Renew
      await renewSharedStateHeartbeat(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        tempRoot,
      );

      // Release
      await releaseSharedState(
        "task-1",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      const state = await getSharedState("task-1", tempRoot);

      expect(state.eventLog).toHaveLength(3);
      expect(state.eventLog[0].event).toBe("claimed");
      expect(state.eventLog[1].event).toBe("renewed");
      expect(state.eventLog[2].event).toBe("released");
      expect(state.eventLog[2].details).toContain("complete");
    });

    it("includes details in conflict events", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await claimTaskInSharedState(
        "task-1",
        "workstation-2/agent-2",
        "token-456",
        300,
        tempRoot,
      );

      const state = result.state;
      const conflictEvent = state.eventLog.find((e) => e.event === "conflict");

      expect(conflictEvent).toBeDefined();
      expect(conflictEvent.ownerId).toBe("workstation-2/agent-2");
      expect(conflictEvent.details).toContain("rejected");
    });

    it("bounds event log to MAX_EVENT_LOG_ENTRIES", async () => {
      const { MAX_EVENT_LOG_ENTRIES } =
        await import("../shared-state-manager.mjs");

      // Generate many events
      for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 10; i++) {
        await claimTaskInSharedState(
          "task-many-events",
          `workstation-1/agent-1`,
          `token-${i}`,
          300,
          tempRoot,
        );
      }

      const state = await getSharedState("task-many-events", tempRoot);

      expect(state.eventLog.length).toBeLessThanOrEqual(MAX_EVENT_LOG_ENTRIES);
    });
  });

  describe("corruption recovery", () => {
    it("recovers from corrupted JSON", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const registryPath = join(
        tempRoot,
        ".cache",
        "openfleet",
        "shared-task-states.json",
      );
      await mkdir(join(tempRoot, ".cache", "openfleet"), {
        recursive: true,
      });
      await writeFile(registryPath, "{ invalid json }", "utf-8");

      const { claimTaskInSharedState } =
        await import("../shared-state-manager.mjs");

      const result = await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);

      // Check that backup was created
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(tempRoot, ".cache", "openfleet"));
      expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);
    });

    it("recovers from invalid structure", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const registryPath = join(
        tempRoot,
        ".cache",
        "openfleet",
        "shared-task-states.json",
      );
      await mkdir(join(tempRoot, ".cache", "openfleet"), {
        recursive: true,
      });
      await writeFile(
        registryPath,
        JSON.stringify({ version: "1.0.0" }),
        "utf-8",
      );

      const { claimTaskInSharedState } =
        await import("../shared-state-manager.mjs");

      const result = await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);
    });
  });

  describe("registry statistics", () => {
    let claimTaskInSharedState,
      releaseSharedState,
      setIgnoreFlag,
      getStateStatistics;

    beforeEach(async () => {
      ({
        claimTaskInSharedState,
        releaseSharedState,
        setIgnoreFlag,
        getStateStatistics,
      } = await import("../shared-state-manager.mjs"));
    });

    it("calculates statistics correctly", async () => {
      await claimTaskInSharedState(
        "task-1",
        "workstation-1/agent-1",
        "token-1",
        300,
        tempRoot,
      );
      await claimTaskInSharedState(
        "task-2",
        "workstation-2/agent-2",
        "token-2",
        300,
        tempRoot,
      );
      await claimTaskInSharedState(
        "task-3",
        "workstation-1/agent-1",
        "token-3",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-3",
        "token-3",
        "complete",
        undefined,
        tempRoot,
      );
      await setIgnoreFlag("task-4", "human_created", tempRoot);

      const stats = await getStateStatistics(tempRoot);

      expect(stats.total).toBe(4);
      expect(stats.claimed).toBe(2);
      expect(stats.complete).toBe(1);
      expect(stats.ignored).toBe(1);
      expect(stats.byOwner["workstation-1/agent-1"]).toBe(2);
      expect(stats.byOwner["workstation-2/agent-2"]).toBe(1);
    });

    it("counts stale tasks correctly", async () => {
      await claimTaskInSharedState(
        "task-stale",
        "workstation-1/agent-1",
        "token-1",
        1,
        tempRoot,
      );
      await claimTaskInSharedState(
        "task-active",
        "workstation-1/agent-1",
        "token-2",
        300,
        tempRoot,
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const stats = await getStateStatistics(tempRoot);

      expect(stats.stale).toBe(1);
    });
  });

  describe("cleanup operations", () => {
    let claimTaskInSharedState, releaseSharedState, cleanupOldStates;

    beforeEach(async () => {
      ({ claimTaskInSharedState, releaseSharedState, cleanupOldStates } =
        await import("../shared-state-manager.mjs"));
    });

    it("cleans up old completed tasks", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");

      // Create old completed task manually
      const registryPath = join(
        tempRoot,
        ".cache",
        "openfleet",
        "shared-task-states.json",
      );
      await mkdir(join(tempRoot, ".cache", "openfleet"), {
        recursive: true,
      });

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const registry = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        tasks: {
          "task-old": {
            taskId: "task-old",
            ownerId: "workstation-1/agent-1",
            ownerHeartbeat: oldDate.toISOString(),
            attemptToken: "token-old",
            attemptStarted: oldDate.toISOString(),
            attemptStatus: "complete",
            retryCount: 0,
            eventLog: [],
          },
        },
      };

      await writeFile(registryPath, JSON.stringify(registry), "utf-8");

      const result = await cleanupOldStates(7, tempRoot);

      expect(result.cleanedCount).toBe(1);
      expect(result.cleanedTasks).toContain("task-old");
    });

    it("does not clean up recent completed tasks", async () => {
      await claimTaskInSharedState(
        "task-recent",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );
      await releaseSharedState(
        "task-recent",
        "token-123",
        "complete",
        undefined,
        tempRoot,
      );

      const result = await cleanupOldStates(7, tempRoot);

      expect(result.cleanedCount).toBe(0);
    });

    it("does not clean up active tasks", async () => {
      await claimTaskInSharedState(
        "task-active",
        "workstation-1/agent-1",
        "token-123",
        300,
        tempRoot,
      );

      const result = await cleanupOldStates(0, tempRoot);

      expect(result.cleanedCount).toBe(0);
    });
  });
});
