import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Mock presence.mjs before importing task-claims.mjs
vi.mock("../presence.mjs", () => ({
  getPresenceState: vi.fn(() => ({
    instance_id: "test-instance-1",
    coordinator_priority: 100,
  })),
  listActiveInstances: vi.fn(() => []),
  selectCoordinator: vi.fn(() => ({
    instance_id: "coordinator-instance",
  })),
  initPresence: vi.fn(async () => ({})),
}));

describe("task-claims", () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "codex-claims-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  describe("initTaskClaims", () => {
    it("initializes with default settings", async () => {
      const { initTaskClaims } = await import("../task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });
      // Should not throw
    });
  });

  describe("claimTask", () => {
    let initTaskClaims, claimTask, getClaim;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, getClaim } = await import(
        "../task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("claims a task successfully", async () => {
      const result = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        ttlMinutes: 30,
      });

      expect(result.success).toBe(true);
      expect(result.token).toBeTruthy();
      expect(result.claim).toBeDefined();
      expect(result.claim.task_id).toBe("task-1");
      expect(result.claim.instance_id).toBe("instance-1");
      expect(result.claim.ttl_minutes).toBe(30);
    });

    it("returns idempotent result for same token", async () => {
      const token = "idempotent-token-123";
      const result1 = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        claimToken: token,
      });

      expect(result1.success).toBe(true);

      const result2 = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        claimToken: token,
      });

      expect(result2.success).toBe(true);
      expect(result2.idempotent).toBe(true);
      expect(result2.token).toBe(token);
    });

    it("rejects duplicate claim from different instance", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const result = await claimTask({
        taskId: "task-1",
        instanceId: "instance-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("task_already_claimed");
      expect(result.existing_instance).toBe("instance-1");
    });

    it("stores claim metadata", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        metadata: { branch: "ve/task-1", agent: "codex" },
      });

      const claim = await getClaim("task-1");
      expect(claim.metadata.branch).toBe("ve/task-1");
      expect(claim.metadata.agent).toBe("codex");
    });

    it("reclaims a task when existing owner is stale/offline", async () => {
      const { listActiveInstances } = vi.mocked(await import("../presence.mjs"));
      await claimTask({
        taskId: "task-stale",
        instanceId: "instance-1",
      });

      listActiveInstances.mockReturnValueOnce([{ instance_id: "instance-2" }]);
      const result = await claimTask({
        taskId: "task-stale",
        instanceId: "instance-2",
      });

      expect(result.success).toBe(true);
      expect(result.resolution?.override).toBe(true);
      expect(result.resolution?.reason).toBe("owner_stale");
      expect(result.claim.instance_id).toBe("instance-2");
    });

    it("does not reclaim when existing owner is active", async () => {
      const { listActiveInstances } = vi.mocked(await import("../presence.mjs"));
      await claimTask({
        taskId: "task-active",
        instanceId: "instance-1",
      });

      listActiveInstances.mockReturnValue([{ instance_id: "instance-1" }]);
      const result = await claimTask({
        taskId: "task-active",
        instanceId: "instance-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("task_already_claimed");
      expect(result.existing_instance).toBe("instance-1");
    });
  });

  describe("releaseTask", () => {
    let initTaskClaims, claimTask, releaseTask, getClaim;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, releaseTask, getClaim } = await import(
        "../task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("releases a claimed task", async () => {
      const claimResult = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const releaseResult = await releaseTask({
        taskId: "task-1",
        claimToken: claimResult.token,
        instanceId: "instance-1",
      });

      expect(releaseResult.success).toBe(true);

      const claim = await getClaim("task-1");
      expect(claim).toBeNull();
    });

    it("rejects release from different instance without force", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const releaseResult = await releaseTask({
        taskId: "task-1",
        instanceId: "instance-2",
      });

      expect(releaseResult.success).toBe(false);
      expect(releaseResult.error).toBe("task_claimed_by_different_instance");
    });

    it("allows force release from different instance", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const releaseResult = await releaseTask({
        taskId: "task-1",
        instanceId: "instance-2",
        force: true,
      });

      expect(releaseResult.success).toBe(true);
    });

    it("returns error when releasing unclaimed task", async () => {
      const releaseResult = await releaseTask({
        taskId: "nonexistent-task",
        instanceId: "instance-1",
      });

      expect(releaseResult.success).toBe(false);
      expect(releaseResult.error).toBe("task_not_claimed");
    });
  });

  describe("renewClaim", () => {
    let initTaskClaims, claimTask, renewClaim, getClaim;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, renewClaim, getClaim } = await import(
        "../task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("renews a claim with new TTL", async () => {
      const claimResult = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        ttlMinutes: 30,
      });

      const originalExpiry = claimResult.claim.expires_at;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      const renewResult = await renewClaim({
        taskId: "task-1",
        claimToken: claimResult.token,
        instanceId: "instance-1",
        ttlMinutes: 60,
      });

      expect(renewResult.success).toBe(true);
      expect(renewResult.claim.expires_at).not.toBe(originalExpiry);
      expect(renewResult.claim.ttl_minutes).toBe(60);
      expect(renewResult.claim.renewed_at).toBeTruthy();
    });

    it("rejects renewal from different instance", async () => {
      const claimResult = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const renewResult = await renewClaim({
        taskId: "task-1",
        claimToken: claimResult.token,
        instanceId: "instance-2",
      });

      expect(renewResult.success).toBe(false);
      expect(renewResult.error).toBe("task_claimed_by_different_instance");
    });

    it("rejects renewal with wrong token", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const renewResult = await renewClaim({
        taskId: "task-1",
        claimToken: "wrong-token",
        instanceId: "instance-1",
      });

      expect(renewResult.success).toBe(false);
      expect(renewResult.error).toBe("claim_token_mismatch");
    });
  });

  describe("listClaims", () => {
    let initTaskClaims, claimTask, listClaims;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, listClaims } = await import(
        "../task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("lists all active claims", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });
      await claimTask({ taskId: "task-2", instanceId: "instance-2" });
      await claimTask({ taskId: "task-3", instanceId: "instance-1" });

      const claims = await listClaims();

      expect(claims).toHaveLength(3);
    });

    it("filters claims by instance ID", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });
      await claimTask({ taskId: "task-2", instanceId: "instance-2" });
      await claimTask({ taskId: "task-3", instanceId: "instance-1" });

      const claims = await listClaims({ instanceId: "instance-1" });

      expect(claims).toHaveLength(2);
      expect(claims.every((c) => c.instance_id === "instance-1")).toBe(true);
    });

    it("excludes expired claims by default", async () => {
      const { _test } = await import("../task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      // Manually create an expired claim
      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-2"] = {
        task_id: "task-2",
        instance_id: "instance-1",
        claim_token: "token-2",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const claims = await listClaims();

      expect(claims).toHaveLength(1);
      expect(claims[0].task_id).toBe("task-1");
    });

    it("includes expired claims when requested", async () => {
      const { _test } = await import("../task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      // Manually create an expired claim
      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-2"] = {
        task_id: "task-2",
        instance_id: "instance-1",
        claim_token: "token-2",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const claims = await listClaims({ includeExpired: true });

      expect(claims).toHaveLength(2);
    });
  });

  describe("isTaskClaimed", () => {
    let initTaskClaims, claimTask, isTaskClaimed;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, isTaskClaimed } = await import(
        "../task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("returns true for claimed task", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      const claimed = await isTaskClaimed("task-1");
      expect(claimed).toBe(true);
    });

    it("returns false for unclaimed task", async () => {
      const claimed = await isTaskClaimed("nonexistent-task");
      expect(claimed).toBe(false);
    });

    it("returns false for expired claim", async () => {
      const { _test } = await import("../task-claims.mjs");

      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-1"] = {
        task_id: "task-1",
        instance_id: "instance-1",
        claim_token: "token-1",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const claimed = await isTaskClaimed("task-1");
      expect(claimed).toBe(false);
    });
  });

  describe("getClaimStats", () => {
    let initTaskClaims, claimTask, getClaimStats;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, getClaimStats } = await import(
        "../task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("calculates statistics correctly", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });
      await claimTask({ taskId: "task-2", instanceId: "instance-2" });
      await claimTask({ taskId: "task-3", instanceId: "instance-1" });

      const stats = await getClaimStats();

      expect(stats.total).toBe(3);
      expect(stats.active).toBe(3);
      expect(stats.expired).toBe(0);
      expect(stats.by_instance["instance-1"]).toBe(2);
      expect(stats.by_instance["instance-2"]).toBe(1);
    });

    it("counts expired claims separately", async () => {
      const { _test } = await import("../task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-2"] = {
        task_id: "task-2",
        instance_id: "instance-1",
        claim_token: "token-2",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const stats = await getClaimStats();

      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.expired).toBe(1);
    });
  });

  describe("resolveDuplicateClaim", () => {
    let _test;

    beforeEach(async () => {
      ({ _test } = await import("../task-claims.mjs"));
    });

    it("coordinator always wins against non-coordinator", async () => {
      const { getPresenceState, selectCoordinator } = vi.mocked(
        await import("../presence.mjs"),
      );
      selectCoordinator.mockReturnValue({ instance_id: "coordinator" });

      const existing = {
        instance_id: "instance-1",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "coordinator",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 10,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(newClaim);
      expect(result.reason).toBe("new_is_coordinator");
    });

    it("lower priority wins when neither is coordinator", async () => {
      const { selectCoordinator } = vi.mocked(await import("../presence.mjs"));
      selectCoordinator.mockReturnValue({ instance_id: "other" });

      const existing = {
        instance_id: "instance-1",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "instance-2",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 50,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(newClaim);
      expect(result.reason).toBe("new_lower_priority");
    });

    it("earlier timestamp wins when priorities are equal", async () => {
      const { selectCoordinator } = vi.mocked(await import("../presence.mjs"));
      selectCoordinator.mockReturnValue(null);

      const earlier = new Date(Date.now() - 1000).toISOString();
      const later = new Date().toISOString();

      const existing = {
        instance_id: "instance-1",
        claimed_at: earlier,
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "instance-2",
        claimed_at: later,
        coordinator_priority: 100,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(existing);
      expect(result.reason).toBe("existing_earlier");
    });

    it("uses instance ID as tie-breaker", async () => {
      const { selectCoordinator } = vi.mocked(await import("../presence.mjs"));
      selectCoordinator.mockReturnValue(null);

      const timestamp = new Date().toISOString();

      const existing = {
        instance_id: "instance-b",
        claimed_at: timestamp,
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "instance-a",
        claimed_at: timestamp,
        coordinator_priority: 100,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(newClaim);
      expect(result.reason).toBe("new_instance_id_lower");
    });
  });

  describe("sweepExpiredClaims", () => {
    let _test;

    beforeEach(async () => {
      ({ _test } = await import("../task-claims.mjs"));
    });

    it("removes expired claims", () => {
      const now = new Date();
      const registry = {
        version: 1,
        claims: {
          "task-1": {
            expires_at: new Date(now.getTime() - 1000).toISOString(),
          },
          "task-2": {
            expires_at: new Date(now.getTime() + 60000).toISOString(),
          },
          "task-3": {
            expires_at: new Date(now.getTime() - 5000).toISOString(),
          },
        },
      };

      const result = _test.sweepExpiredClaims(registry, now);

      expect(result.expiredCount).toBe(2);
      expect(Object.keys(result.registry.claims)).toHaveLength(1);
      expect(result.registry.claims["task-2"]).toBeDefined();
    });

    it("handles empty claims", () => {
      const registry = { version: 1, claims: {} };
      const result = _test.sweepExpiredClaims(registry);

      expect(result.expiredCount).toBe(0);
      expect(Object.keys(result.registry.claims)).toHaveLength(0);
    });
  });

  describe("coordinator override", () => {
    let initTaskClaims, claimTask;

    beforeEach(async () => {
      const { getPresenceState, selectCoordinator } = vi.mocked(
        await import("../presence.mjs"),
      );

      ({ initTaskClaims, claimTask } = await import("../task-claims.mjs"));
      await initTaskClaims({ repoRoot: tempRoot });

      // Setup: instance-1 claims first
      getPresenceState.mockReturnValue({
        instance_id: "instance-1",
        coordinator_priority: 100,
      });
      selectCoordinator.mockReturnValue({ instance_id: "coordinator" });
    });

    it("coordinator can override existing non-coordinator claim", async () => {
      const { getPresenceState } = vi.mocked(await import("../presence.mjs"));

      // First claim from non-coordinator
      getPresenceState.mockReturnValue({
        instance_id: "instance-1",
        coordinator_priority: 100,
      });
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      // Coordinator claims
      getPresenceState.mockReturnValue({
        instance_id: "coordinator",
        coordinator_priority: 10,
      });
      const result = await claimTask({
        taskId: "task-1",
        instanceId: "coordinator",
      });

      expect(result.success).toBe(true);
      expect(result.resolution.override).toBe(true);
      expect(result.resolution.reason).toBe("new_is_coordinator");
    });
  });
});
