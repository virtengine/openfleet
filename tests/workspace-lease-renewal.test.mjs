import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  loadSharedWorkspaceRegistry,
  saveSharedWorkspaceRegistry,
  renewSharedWorkspaceLease,
  claimSharedWorkspace,
  sweepExpiredLeases,
} from "../shared-workspace-registry.mjs";

let TEST_DIR = "";
let TEST_REGISTRY_PATH = "";
let TEST_AUDIT_PATH = "";

describe("workspace-registry lease renewal", () => {
  beforeEach(async () => {
    TEST_DIR = await mkdtemp(resolve(tmpdir(), "codex-workspace-registry-"));
    TEST_REGISTRY_PATH = resolve(TEST_DIR, "test-registry.json");
    TEST_AUDIT_PATH = resolve(TEST_DIR, "test-audit.jsonl");
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should renew an active lease", async () => {
    const now = new Date("2026-02-08T10:00:00Z");
    const registry = {
      version: 1,
      registry_name: "test",
      default_lease_ttl_minutes: 120,
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

    // Claim the workspace
    const claimResult = await claimSharedWorkspace({
      workspaceId: "ws1",
      owner: "test-owner",
      ttlMinutes: 60,
      actor: "test-actor",
      now: now,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    expect(claimResult.error).toBeUndefined();
    expect(claimResult.lease).toBeDefined();
    const originalExpiry = claimResult.lease.lease_expires_at;

    // Renew the lease
    const renewNow = new Date("2026-02-08T10:30:00Z");
    const renewResult = await renewSharedWorkspaceLease({
      workspaceId: "ws1",
      owner: "test-owner",
      ttlMinutes: 90,
      actor: "test-actor",
      now: renewNow,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    expect(renewResult.error).toBeUndefined();
    expect(renewResult.lease).toBeDefined();
    expect(renewResult.lease.lease_expires_at).not.toBe(originalExpiry);
    expect(renewResult.lease.last_renewed_at).toBe(renewNow.toISOString());
    
    // New expiry should be renewNow + 90 minutes
    const expectedExpiry = new Date(renewNow.getTime() + 90 * 60 * 1000).toISOString();
    expect(renewResult.lease.lease_expires_at).toBe(expectedExpiry);
  });

  it("should reject renewal for non-existent workspace", async () => {
    const now = new Date("2026-02-08T10:00:00Z");
    const registry = {
      version: 1,
      registry_name: "test",
      default_lease_ttl_minutes: 120,
      workspaces: [],
      registry_path: TEST_REGISTRY_PATH,
      audit_log_path: TEST_AUDIT_PATH,
    };

    await saveSharedWorkspaceRegistry(registry, {
      registryPath: TEST_REGISTRY_PATH,
    });

    const renewResult = await renewSharedWorkspaceLease({
      workspaceId: "nonexistent",
      owner: "test-owner",
      now: now,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    expect(renewResult.error).toBeDefined();
    expect(renewResult.error).toContain("Unknown");
  });

  it("should reject renewal for unleased workspace", async () => {
    const now = new Date("2026-02-08T10:00:00Z");
    const registry = {
      version: 1,
      registry_name: "test",
      default_lease_ttl_minutes: 120,
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

    const renewResult = await renewSharedWorkspaceLease({
      workspaceId: "ws1",
      owner: "test-owner",
      now: now,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    expect(renewResult.error).toBeDefined();
    expect(renewResult.error).toContain("not currently leased");
  });

  it("should reject renewal by wrong owner", async () => {
    const now = new Date("2026-02-08T10:00:00Z");
    const registry = {
      version: 1,
      registry_name: "test",
      default_lease_ttl_minutes: 120,
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

    // Claim by owner1
    await claimSharedWorkspace({
      workspaceId: "ws1",
      owner: "owner1",
      ttlMinutes: 60,
      now: now,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    // Try to renew by owner2
    const renewResult = await renewSharedWorkspaceLease({
      workspaceId: "ws1",
      owner: "owner2",
      now: now,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    expect(renewResult.error).toBeDefined();
    expect(renewResult.error).toContain("cannot renew");
  });

  it("should use default TTL if not specified", async () => {
    const now = new Date("2026-02-08T10:00:00Z");
    const registry = {
      version: 1,
      registry_name: "test",
      default_lease_ttl_minutes: 120,
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

    // Claim with 60 minute TTL
    await claimSharedWorkspace({
      workspaceId: "ws1",
      owner: "test-owner",
      ttlMinutes: 60,
      now: now,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    // Renew without specifying TTL - should use workspace's TTL (60) from claim
    const renewNow = new Date("2026-02-08T10:30:00Z");
    const renewResult = await renewSharedWorkspaceLease({
      workspaceId: "ws1",
      owner: "test-owner",
      now: renewNow,
      registryPath: TEST_REGISTRY_PATH,
      auditPath: TEST_AUDIT_PATH,
    });

    expect(renewResult.error).toBeUndefined();
    expect(renewResult.lease.lease_ttl_minutes).toBe(60);
  });
});
