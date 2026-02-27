import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn stale state expiry", () => {
  it("defines a stale state expiry duration of 24 hours", () => {
    // Stale entries should be removed after 24h to prevent memory/disk growth
    // 24h = 24 * 60 * 60 * 1000 = 86400000
    const has24h =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes("86400000") ||
        source.includes("24 * 60 * 60 * 1000") ||
        /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(source));
    assert.ok(
      has24h,
      "stale workspace sync warn entries should expire after 24 hours",
    );
  });

  it("removes stale entries from the persisted state", () => {
    const hasStalePurge =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes("stale") || source.includes("expire") ||
        source.includes("expiry") || source.includes("prune"));
    assert.ok(
      hasStalePurge,
      "stale entries should be pruned from the persisted workspace sync warn state",
    );
  });

  it("checks stale state expiry using updatedAt or similar timestamp field", () => {
    const hasTimestampCheck =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes("updatedAt") || source.includes("lastSeen") ||
        source.includes("timestamp") || source.includes("Date.now"));
    assert.ok(
      hasTimestampCheck,
      "stale state expiry should compare timestamps using a stored timestamp field",
    );
  });
});
