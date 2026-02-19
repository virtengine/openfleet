import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, utimes, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  cleanOrphanedWorktrees,
  runReaperSweep,
  formatReaperResults,
  calculateReaperMetrics,
} from "../workspace-reaper.mjs";
import {
  saveSharedWorkspaceRegistry,
  claimSharedWorkspace,
} from "../shared-workspace-registry.mjs";

let TEST_DIR = "";
let TEST_WORKTREE_BASE = "";
let TEST_REGISTRY_PATH = "";
let TEST_AUDIT_PATH = "";

async function createTestWorktree(name, options = {}) {
  const worktreePath = resolve(TEST_WORKTREE_BASE, name);
  await mkdir(worktreePath, { recursive: true });
  const gitDir = resolve(worktreePath, ".git");
  await mkdir(gitDir, { recursive: true });
  const gitHead = resolve(gitDir, "HEAD");
  await writeFile(gitHead, "ref: refs/heads/main");

  // Create some test files
  const testFile = resolve(worktreePath, "test.txt");
  await writeFile(testFile, "test content");

  if (options.modifiedAt instanceof Date) {
    await utimes(testFile, options.modifiedAt, options.modifiedAt);
    await utimes(worktreePath, options.modifiedAt, options.modifiedAt);
    await utimes(gitDir, options.modifiedAt, options.modifiedAt);
    await utimes(gitHead, options.modifiedAt, options.modifiedAt);
  }
  if (options.withLockFile) {
    await writeFile(resolve(worktreePath, ".git", "index.lock"), "12345");
  }

  if (options.withPidFile) {
    await writeFile(
      resolve(worktreePath, ".openfleet.pid"),
      String(options.pid || "99999"),
    );
  }

  return worktreePath;
}

describe("workspace-reaper", () => {
  beforeEach(async () => {
    TEST_DIR = await mkdtemp(resolve(tmpdir(), "codex-workspace-reaper-"));
    TEST_WORKTREE_BASE = resolve(TEST_DIR, "worktrees");
    TEST_REGISTRY_PATH = resolve(TEST_DIR, "test-registry.json");
    TEST_AUDIT_PATH = resolve(TEST_DIR, "test-audit.jsonl");
    await mkdir(TEST_WORKTREE_BASE, { recursive: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("cleanOrphanedWorktrees", () => {
    it("should skip recently modified worktrees", async () => {
      await createTestWorktree("recent-worktree");

      const result = await cleanOrphanedWorktrees({
        searchPaths: [TEST_WORKTREE_BASE],
        orphanThresholdHours: 24,
        now: new Date(),
      });

      expect(result.scanned).toBe(1);
      expect(result.cleaned).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skipped_reasons.recently_modified).toBe(1);
      expect(existsSync(resolve(TEST_WORKTREE_BASE, "recent-worktree"))).toBe(
        true,
      );
    });

    it("should skip worktrees with active processes", async () => {
      // Use the current process PID to simulate an active process
      await createTestWorktree("active-worktree", {
        withPidFile: true,
        pid: process.pid,
      });

      const result = await cleanOrphanedWorktrees({
        searchPaths: [TEST_WORKTREE_BASE],
        orphanThresholdHours: 0,
        now: new Date(),
      });

      expect(result.scanned).toBe(1);
      expect(result.cleaned).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skipped_reasons.active_process).toBe(1);
    });

    it("should clean old orphaned worktrees", async () => {
      const worktreePath = await createTestWorktree("old-worktree");

      // Simulate an old worktree by setting test time far in future
      const futureTime = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours ahead

      const result = await cleanOrphanedWorktrees({
        searchPaths: [TEST_WORKTREE_BASE],
        orphanThresholdHours: 24,
        now: futureTime,
      });

      expect(result.scanned).toBe(1);
      expect(result.cleaned).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.cleaned_paths).toHaveLength(1);
      expect(result.cleaned_paths[0].path).toBe(worktreePath);
      expect(existsSync(worktreePath)).toBe(false);
    });

    it("should support dry-run mode", async () => {
      const now = new Date();
      await createTestWorktree("old-worktree", { modifiedAt: now });

      const futureTime = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const result = await cleanOrphanedWorktrees({
        searchPaths: [TEST_WORKTREE_BASE],
        orphanThresholdHours: 24,
        now: futureTime,
        dryRun: true,
      });

      expect(result.scanned).toBe(1);
      expect(result.cleaned).toBe(1);
      expect(result.cleaned_paths[0].dryRun).toBe(true);
      expect(existsSync(resolve(TEST_WORKTREE_BASE, "old-worktree"))).toBe(
        true,
      );
    });

    it("should handle multiple worktrees", async () => {
      await createTestWorktree("worktree1");
      await createTestWorktree("worktree2");
      await createTestWorktree("worktree3", {
        withPidFile: true,
        pid: process.pid,
      });

      const futureTime = new Date(Date.now() + 48 * 60 * 60 * 1000);

      const result = await cleanOrphanedWorktrees({
        searchPaths: [TEST_WORKTREE_BASE],
        orphanThresholdHours: 24,
        now: futureTime,
      });

      expect(result.scanned).toBe(3);
      expect(result.cleaned).toBe(2); // worktree1 and worktree2
      expect(result.skipped).toBe(1); // worktree3 with active PID
      expect(result.skipped_reasons.active_process).toBe(1);
    });
  });

  describe("runReaperSweep", () => {
    it("should sweep expired leases and clean worktrees", async () => {
      // Setup: Create registry with expired lease
      const now = new Date("2026-02-08T10:00:00Z");
      const registry = {
        version: 1,
        registry_name: "test",
        default_lease_ttl_minutes: 60,
        workspaces: [
          {
            id: "ws1",
            name: "Test Workspace",
            provider: "test",
            availability: "available",
          },
        ],
        registry_path: TEST_REGISTRY_PATH,
        audit_log_path: TEST_AUDIT_PATH,
      };

      await saveSharedWorkspaceRegistry(registry, {
        registryPath: TEST_REGISTRY_PATH,
      });

      // Claim workspace with 60 minute TTL
      await claimSharedWorkspace({
        workspaceId: "ws1",
        owner: "test-owner",
        ttlMinutes: 60,
        now: now,
        registryPath: TEST_REGISTRY_PATH,
        auditPath: TEST_AUDIT_PATH,
      });

      // Create an old worktree
      await createTestWorktree("old-worktree", { modifiedAt: now });

      // Run reaper 2 hours later (lease expired, worktree old)
      const laterTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const result = await runReaperSweep({
        searchPaths: [TEST_WORKTREE_BASE],
        orphanThresholdHours: 1,
        now: laterTime,
        registryPath: TEST_REGISTRY_PATH,
        auditPath: TEST_AUDIT_PATH,
      });

      expect(result.leases.expired).toBe(1);
      expect(result.leases.cleaned).toBe(1);
      expect(result.worktrees.scanned).toBe(1);
      expect(result.worktrees.cleaned).toBe(1);
    });

    it("should handle empty registries and worktree paths", async () => {
      const result = await runReaperSweep({
        searchPaths: [resolve(TEST_WORKTREE_BASE, "nonexistent")],
        now: new Date(),
        registryPath: resolve(TEST_DIR, "nonexistent-registry.json"),
        auditPath: TEST_AUDIT_PATH,
      });

      expect(result.leases.expired).toBe(0);
      expect(result.worktrees.scanned).toBe(0);
      expect(result.worktrees.cleaned).toBe(0);
    });
  });

  describe("formatReaperResults", () => {
    it("should format results correctly", () => {
      const results = {
        timestamp: "2026-02-08T10:00:00.000Z",
        leases: {
          expired: 2,
          cleaned: 2,
          errors: [],
        },
        worktrees: {
          scanned: 5,
          cleaned: 3,
          skipped: 2,
          errors: [],
          skipped_reasons: {
            recently_modified: 1,
            active_process: 1,
          },
        },
      };

      const formatted = formatReaperResults(results);

      expect(formatted).toContain(
        "Sweep completed at 2026-02-08T10:00:00.000Z",
      );
      expect(formatted).toContain("Leases: 2 expired, 2 cleaned");
      expect(formatted).toContain("Worktrees: 5 scanned, 3 cleaned, 2 skipped");
      expect(formatted).toContain("recently_modified: 1");
      expect(formatted).toContain("active_process: 1");
    });
  });

  describe("calculateReaperMetrics", () => {
    it("should calculate metrics correctly", () => {
      const results = {
        timestamp: "2026-02-08T10:00:00.000Z",
        leases: {
          expired: 2,
          cleaned: 2,
          errors: ["error1"],
        },
        worktrees: {
          scanned: 5,
          cleaned: 3,
          skipped: 2,
          errors: [],
        },
      };

      const metrics = calculateReaperMetrics(results);

      expect(metrics.timestamp).toBe("2026-02-08T10:00:00.000Z");
      expect(metrics.leases_expired).toBe(2);
      expect(metrics.leases_cleaned).toBe(2);
      expect(metrics.lease_errors).toBe(1);
      expect(metrics.worktrees_scanned).toBe(5);
      expect(metrics.worktrees_cleaned).toBe(3);
      expect(metrics.worktrees_skipped).toBe(2);
      expect(metrics.worktree_errors).toBe(0);
      expect(metrics.total_cleaned).toBe(5);
      expect(metrics.total_errors).toBe(1);
    });
  });
});
