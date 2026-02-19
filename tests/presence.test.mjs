import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  formatPresenceMessage,
  parsePresenceMessage,
  listActiveInstances,
  selectCoordinator,
  formatPresenceSummary,
  formatCoordinatorSummary,
  getPresencePrefix,
  initPresence,
  getPresenceState,
} from "../presence.mjs";

let tempRoot = null;

async function initTestPresence(instanceId) {
  tempRoot = await mkdtemp(resolve(tmpdir(), "openfleet-presence-"));
  await initPresence({
    repoRoot: tempRoot,
    presencePath: resolve(tempRoot, "presence.json"),
    instanceId,
    force: true,
    skipLoad: true,
  });
}

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe("getPresencePrefix", () => {
  it("returns the correct prefix", () => {
    expect(getPresencePrefix()).toBe("[ve-presence]");
  });
});

describe("formatPresenceMessage", () => {
  it("serializes a full payload with prefix", () => {
    const payload = {
      instance_id: "test-instance",
      workspace_id: "ws-123",
      workspace_role: "coordinator",
      coordinator_priority: 10,
      host: "testhost",
      platform: "linux",
      node: "v20.0.0",
      pid: 12345,
    };

    const result = formatPresenceMessage(payload);

    expect(result).toContain("[ve-presence]");
    expect(result).toContain('"instance_id":"test-instance"');
    expect(result).toContain('"workspace_role":"coordinator"');
  });

  it("handles minimal payload", () => {
    const payload = { instance_id: "minimal" };
    const result = formatPresenceMessage(payload);

    expect(result).toBe('[ve-presence] {"instance_id":"minimal"}');
  });

  it("roundtrips with parsePresenceMessage", () => {
    const payload = {
      instance_id: "roundtrip-test",
      workspace_id: "ws-456",
      workspace_role: "worker",
      coordinator_priority: 100,
      coordinator_eligible: true,
    };

    const formatted = formatPresenceMessage(payload);
    const parsed = parsePresenceMessage(formatted);

    expect(parsed).not.toBeNull();
    expect(parsed.instance_id).toBe("roundtrip-test");
    expect(parsed.workspace_id).toBe("ws-456");
    expect(parsed.workspace_role).toBe("worker");
    expect(parsed.coordinator_priority).toBe(100);
    expect(parsed.coordinator_eligible).toBe(true);
  });
});

describe("parsePresenceMessage", () => {
  it("parses valid [ve-presence] format", () => {
    const text =
      '[ve-presence] {"instance_id":"test-123","workspace_role":"coordinator","coordinator_priority":10}';

    const result = parsePresenceMessage(text);

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("test-123");
    expect(result.workspace_role).toBe("coordinator");
    expect(result.coordinator_priority).toBe(10);
  });

  it("handles extra whitespace around JSON", () => {
    const text =
      '[ve-presence]    {"instance_id":"test-456","coordinator_priority":20}   ';

    const result = parsePresenceMessage(text);

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("test-456");
    expect(result.coordinator_priority).toBe(20);
  });

  it("handles prefix in middle of text", () => {
    const text =
      'some prefix text [ve-presence] {"instance_id":"test-789"}';

    const result = parsePresenceMessage(text);

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("test-789");
  });

  it("returns null for invalid JSON", () => {
    const text = "[ve-presence] {invalid json}";

    const result = parsePresenceMessage(text);

    expect(result).toBeNull();
  });

  it("returns null when prefix is missing", () => {
    const text = '{"instance_id":"no-prefix"}';

    const result = parsePresenceMessage(text);

    expect(result).toBeNull();
  });

  it("returns null when JSON does not start with {", () => {
    const text = "[ve-presence] not-a-json-object";

    const result = parsePresenceMessage(text);

    expect(result).toBeNull();
  });

  it("normalizes coordinator_eligible to boolean", () => {
    const text1 = '[ve-presence] {"instance_id":"test-1"}';
    const text2 =
      '[ve-presence] {"instance_id":"test-2","coordinator_eligible":false}';

    const result1 = parsePresenceMessage(text1);
    const result2 = parsePresenceMessage(text2);

    expect(result1.coordinator_eligible).toBe(true); // default
    expect(result2.coordinator_eligible).toBe(false);
  });

  it("normalizes coordinator_priority to number", () => {
    const text1 = '[ve-presence] {"instance_id":"test-1"}';
    const text2 =
      '[ve-presence] {"instance_id":"test-2","coordinator_priority":"50"}';

    const result1 = parsePresenceMessage(text1);
    const result2 = parsePresenceMessage(text2);

    expect(result1.coordinator_priority).toBe(100); // default
    expect(result2.coordinator_priority).toBe(50);
  });
});

describe("listActiveInstances", () => {
  beforeEach(async () => {
    await initTestPresence("test-init");
  });

  it("returns all instances when TTL is 0", async () => {
    // Inject test data
    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence({
          instance_id: "inst-1",
          last_seen_at: new Date(Date.now() - 1000).toISOString(),
        }),
        m.notePresence({
          instance_id: "inst-2",
          last_seen_at: new Date(Date.now() - 5000).toISOString(),
        }),
        m.notePresence({
          instance_id: "inst-3",
          last_seen_at: new Date(Date.now() - 10000).toISOString(),
        }),
      ]),
    );

    const result = listActiveInstances({ nowMs: Date.now(), ttlMs: 0 });

    expect(result.length).toBeGreaterThanOrEqual(3);
    const ids = result.map((r) => r.instance_id);
    expect(ids).toContain("inst-1");
    expect(ids).toContain("inst-2");
    expect(ids).toContain("inst-3");
  });

  it("filters out stale instances based on TTL", async () => {
    const now = 10000;
    const ttl = 3000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          { instance_id: "fresh-1" },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          { instance_id: "fresh-2" },
          { receivedAt: new Date(now - 2000).toISOString() },
        ),
        m.notePresence(
          { instance_id: "stale-1" },
          { receivedAt: new Date(now - 4000).toISOString() },
        ),
        m.notePresence(
          { instance_id: "stale-2" },
          { receivedAt: new Date(now - 5000).toISOString() },
        ),
      ]),
    );

    const result = listActiveInstances({ nowMs: now, ttlMs: ttl });

    const ids = result.map((r) => r.instance_id);
    expect(ids).toContain("fresh-1");
    expect(ids).toContain("fresh-2");
    expect(ids).not.toContain("stale-1");
    expect(ids).not.toContain("stale-2");
  });

  it("returns empty array when all instances are stale", async () => {
    const now = 10000;
    const ttl = 2000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          { instance_id: "stale-1" },
          { receivedAt: new Date(now - 5000).toISOString() },
        ),
        m.notePresence(
          { instance_id: "stale-2" },
          { receivedAt: new Date(now - 10000).toISOString() },
        ),
      ]),
    );

    const result = listActiveInstances({ nowMs: now, ttlMs: ttl });

    const ids = result.map((r) => r.instance_id);
    expect(ids).not.toContain("stale-1");
    expect(ids).not.toContain("stale-2");
  });

  it("handles TTL boundary exactly at expiry", async () => {
    const now = 10000;
    const ttl = 3000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          { instance_id: "exactly-at-boundary" },
          { receivedAt: new Date(now - ttl).toISOString() },
        ),
        m.notePresence(
          { instance_id: "just-inside" },
          { receivedAt: new Date(now - ttl + 1).toISOString() },
        ),
        m.notePresence(
          { instance_id: "just-outside" },
          { receivedAt: new Date(now - ttl - 1).toISOString() },
        ),
      ]),
    );

    const result = listActiveInstances({ nowMs: now, ttlMs: ttl });

    const ids = result.map((r) => r.instance_id);
    // Exactly at boundary is expired
    expect(ids).not.toContain("exactly-at-boundary");
    expect(ids).not.toContain("just-outside");
    expect(ids).toContain("just-inside");
  });

  it("uses Date.now() when nowMs not provided", async () => {
    await import("../presence.mjs").then((m) =>
      m.notePresence({
        instance_id: "current",
        last_seen_at: new Date().toISOString(),
      }),
    );

    const result = listActiveInstances({ ttlMs: 5000 });

    const ids = result.map((r) => r.instance_id);
    expect(ids).toContain("current");
  });
});

describe("selectCoordinator", () => {
  beforeEach(async () => {
    await initTestPresence("test-coordinator-init");
  });

  it("selects single coordinator-eligible instance", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      m.notePresence(
        {
          instance_id: "solo-coordinator",
          coordinator_eligible: true,
          coordinator_priority: 50,
        },
        { receivedAt: new Date(now - 1000).toISOString() },
      ),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("solo-coordinator");
  });

  it("selects instance with highest priority (lowest number)", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "high-priority",
            coordinator_eligible: true,
            coordinator_priority: 10,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "medium-priority",
            coordinator_eligible: true,
            coordinator_priority: 50,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "low-priority",
            coordinator_eligible: true,
            coordinator_priority: 100,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
      ]),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("high-priority");
  });

  it("returns null when no active instances", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      m.notePresence(
        {
          instance_id: "stale",
          coordinator_eligible: true,
        },
        { receivedAt: new Date(now - 10000).toISOString() },
      ),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    expect(result).toBeNull();
  });

  it("returns null when no eligible instances exist", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "not-eligible-1",
            coordinator_eligible: false,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "not-eligible-2",
            coordinator_eligible: false,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
      ]),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    // Should fallback to active instances even if not eligible
    expect(result).not.toBeNull();
  });

  it("breaks priority ties by started_at timestamp", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "started-first",
            coordinator_eligible: true,
            coordinator_priority: 50,
            started_at: new Date(now - 5000).toISOString(),
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "started-second",
            coordinator_eligible: true,
            coordinator_priority: 50,
            started_at: new Date(now - 3000).toISOString(),
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
      ]),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("started-first");
  });

  it("breaks ties deterministically by instance_id", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "alpha",
            coordinator_eligible: true,
            coordinator_priority: 50,
            started_at: new Date(now - 5000).toISOString(),
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "beta",
            coordinator_eligible: true,
            coordinator_priority: 50,
            started_at: new Date(now - 5000).toISOString(),
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
      ]),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("alpha"); // Lexicographically first
  });

  it("prefers workspace_role=coordinator", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "coordinator-role",
            workspace_role: "coordinator",
            coordinator_eligible: true,
            coordinator_priority: 100,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "worker-role",
            workspace_role: "worker",
            coordinator_eligible: true,
            coordinator_priority: 50,
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
      ]),
    );

    const result = selectCoordinator({ nowMs: now, ttlMs: 5000 });

    expect(result).not.toBeNull();
    expect(result.instance_id).toBe("coordinator-role");
  });
});

describe("formatPresenceSummary", () => {
  beforeEach(async () => {
    await initTestPresence("test-summary-init");
  });

  it("returns message when no active instances", () => {
    const result = formatPresenceSummary({ nowMs: 10000, ttlMs: 1000 });

    expect(result).toBe("No active instances reported.");
  });

  it("formats summary with active instances", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "inst-1",
            instance_label: "Primary Worker",
            workspace_role: "coordinator",
            host: "server-1",
            last_seen_at: new Date(now - 1000).toISOString(),
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "inst-2",
            workspace_role: "worker",
            host: "server-2",
            last_seen_at: new Date(now - 2000).toISOString(),
          },
          { receivedAt: new Date(now - 2000).toISOString() },
        ),
      ]),
    );

    const result = formatPresenceSummary({ nowMs: now, ttlMs: 5000 });

    expect(result).toContain("🛰️ OpenFleet Presence");
    expect(result).toContain("Primary Worker");
    expect(result).toContain("inst-2");
    expect(result).toContain("coordinator");
    expect(result).toContain("worker");
    expect(result).toContain("server-1");
    expect(result).toContain("server-2");
  });

  it("marks coordinator in summary", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      Promise.all([
        m.notePresence(
          {
            instance_id: "coordinator-inst",
            instance_label: "Coordinator",
            workspace_role: "coordinator",
            coordinator_priority: 10,
            host: "coord-host",
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
        m.notePresence(
          {
            instance_id: "worker-inst",
            instance_label: "Worker",
            workspace_role: "worker",
            coordinator_priority: 100,
            host: "worker-host",
          },
          { receivedAt: new Date(now - 1000).toISOString() },
        ),
      ]),
    );

    const result = formatPresenceSummary({ nowMs: now, ttlMs: 5000 });

    expect(result).toContain("Coordinator (coordinator)");
    expect(result).toContain("Worker");
    expect(result).not.toContain("Worker (coordinator)");
  });
});

describe("formatCoordinatorSummary", () => {
  beforeEach(async () => {
    await initTestPresence("test-coord-summary-init");
  });

  it("returns message when no coordinator selected", () => {
    const result = formatCoordinatorSummary({ nowMs: 10000, ttlMs: 1000 });

    expect(result).toBe(
      "No coordinator selected (no active instances).",
    );
  });

  it("formats coordinator details", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      m.notePresence(
        {
          instance_id: "coord-123",
          instance_label: "Main Coordinator",
          workspace_role: "coordinator",
          host: "coord-server",
          last_seen_at: new Date(now - 500).toISOString(),
        },
        { receivedAt: new Date(now - 500).toISOString() },
      ),
    );

    const result = formatCoordinatorSummary({ nowMs: now, ttlMs: 5000 });

    expect(result).toContain("⭐ Coordinator");
    expect(result).toContain("Instance: Main Coordinator");
    expect(result).toContain("Role: coordinator");
    expect(result).toContain("Host: coord-server");
    expect(result).toContain("Last seen:");
  });

  it("uses instance_id when label is missing", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      m.notePresence(
        {
          instance_id: "unlabeled-coord",
          workspace_role: "coordinator",
          host: "test-host",
        },
        { receivedAt: new Date(now - 500).toISOString() },
      ),
    );

    const result = formatCoordinatorSummary({ nowMs: now, ttlMs: 5000 });

    expect(result).toContain("Instance: unlabeled-coord");
  });

  it("handles missing optional fields gracefully", async () => {
    const now = 10000;

    await import("../presence.mjs").then((m) =>
      m.notePresence(
        {
          instance_id: "minimal-coord",
        },
        { receivedAt: new Date(now - 500).toISOString() },
      ),
    );

    const result = formatCoordinatorSummary({ nowMs: now, ttlMs: 5000 });

    expect(result).toContain("⭐ Coordinator");
    expect(result).toContain("Instance: minimal-coord");
    expect(result).toContain("Host: unknown");
  });
});
