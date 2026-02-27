/**
 * Regression tests for the Fleet/Agents tab rendering fix.
 *
 * Validates the patterns that previously caused:
 *   "Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'."
 *
 * Root causes addressed:
 *  1. `entries` array rebuilt every render → infinite useEffect loop.
 *  2. Sibling `&&` conditionals producing mixed false/VNode children.
 *  3. Index-based keys on mutable/reorderable lists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentsPath = resolve(process.cwd(), "ui/tabs/agents.js");
const source = readFileSync(agentsPath, "utf8");

describe("FleetSessionsPanel render stability", () => {
  it("uses useMemo for entries array to prevent infinite render loops", () => {
    // The entries array must be memoised with useMemo, not rebuilt inline
    expect(source).toContain("useMemo");
    // Verify useMemo is imported from preact/hooks
    expect(source).toMatch(/import\s*\{[^}]*useMemo[^}]*\}\s*from\s*["']preact\/hooks["']/);
    // The entries computation should be wrapped in useMemo
    expect(source).toMatch(/const\s+entries\s*=\s*useMemo\s*\(/);
  });

  it("useEffect dependency is a stable primitive, not the entries array itself", () => {
    // The useEffect that auto-selects a slot key must NOT depend on the
    // entries reference directly (which would fire on every render).
    // It should depend on a primitive fingerprint string.
    expect(source).toContain("entriesFingerprint");
    expect(source).toContain("[entriesFingerprint]");
    // Old pattern must be gone:
    expect(source).not.toContain("[entries, selectedSlotKey]");
  });

  it("detail tabs use exclusive ternary, not sibling && expressions", () => {
    // The old pattern had four sibling `&& (...)` blocks inside fleet-session-body.
    // The fix uses a single chained ternary so only one VNode occupies the
    // child position at any time, preventing Preact from calling insertBefore
    // on false/undefined values.
    const bodySection = source.slice(
      source.indexOf("fleet-session-body"),
    );
    // Should NOT contain multiple sibling `detailTab === "..." &&` patterns
    // at the same nesting level inside fleet-session-body
    const bodyChunk = bodySection.slice(0, 2000);
    const andPatterns = (bodyChunk.match(/detailTab\s*===\s*["'][^"']+["']\s*&&/g) || []);
    // With a chained ternary, we should only see ternary (? :) patterns, not &&
    expect(andPatterns.length).toBe(0);
    // Should use ternary pattern for tab switching
    expect(bodyChunk).toMatch(/detailTab\s*===\s*["']stream["']\s*\?/);
    expect(bodyChunk).toMatch(/detailTab\s*===\s*["']context["']\s*\?/);
    expect(bodyChunk).toMatch(/detailTab\s*===\s*["']diff["']\s*\?/);
    expect(bodyChunk).toMatch(/detailTab\s*===\s*["']logs["']\s*\?/);
  });

  it("slot card list uses stable keys, not array indices", () => {
    // Slot cards in the "Active Slots" section must use a content-based key
    // (taskId/sessionId) rather than index `i` to prevent stale DOM references
    // when slots reorder.
    // Find the key= line near fleet-agent-card
    const idx = source.indexOf("fleet-agent-card");
    // Look at ~300 chars before the class name to find the key= attribute
    const searchStart = Math.max(0, idx - 300);
    const surroundingChunk = source.slice(searchStart, idx + 50);
    // Should use a content-derived key (slot?.taskId or similar)
    expect(surroundingChunk).toMatch(/key=\$\{slot\?\.taskId/);
    // Should NOT use key=${i} as the only key
    expect(surroundingChunk).not.toMatch(/key=\$\{i\}\s*\n/);
  });

  it("agent threads list uses stable keys, not array indices", () => {
    // The "Agent Threads" section should key on a stable identifier
    const threadsSection = source.slice(
      source.indexOf("Agent Threads"),
    );
    const statCardChunk = threadsSection.slice(0, 600);
    // Should NOT use key=${i}
    expect(statCardChunk).not.toMatch(/key=\$\{i\}/);
    // Should use a content-derived key
    expect(statCardChunk).toMatch(/key=\$\{t\.taskKey/);
  });
});

describe("fleet entry building logic", () => {
  it("builds stable keys from slot identifiers with fallback", () => {
    // Simulates the entry key generation logic from the component.
    // This verifies the null-safety and fallback behaviour.
    const buildKey = (slot, index) =>
      String(slot?.taskId || slot?.sessionId || `slot-${index}`);

    expect(buildKey({ taskId: "abc-123" }, 0)).toBe("abc-123");
    expect(buildKey({ sessionId: "sess-1" }, 0)).toBe("sess-1");
    expect(buildKey({ taskId: "abc", sessionId: "sess" }, 0)).toBe("abc");
    expect(buildKey({}, 2)).toBe("slot-2");
    expect(buildKey(null, 5)).toBe("slot-5");
    expect(buildKey(undefined, 7)).toBe("slot-7");
  });

  it("generates stable fingerprints across equivalent input", () => {
    const slotsA = [
      { taskId: "t1", sessionId: "s1", startedAt: "2025-01-01T00:00:00Z" },
      { taskId: "t2", sessionId: "s2", startedAt: "2025-01-02T00:00:00Z" },
    ];
    const slotsB = [
      { taskId: "t1", sessionId: "s1", startedAt: "2025-01-01T00:00:00Z" },
      { taskId: "t2", sessionId: "s2", startedAt: "2025-01-02T00:00:00Z" },
    ];

    const buildEntries = (slots) =>
      slots
        .map((slot, index) => {
          const key = String(slot?.taskId || slot?.sessionId || `slot-${index}`);
          return { key, slot, index };
        })
        .sort((a, b) => {
          const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
          const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
          return bScore - aScore;
        });

    const entriesA = buildEntries(slotsA);
    const entriesB = buildEntries(slotsB);

    const fpA = entriesA.map((e) => e.key).join(",");
    const fpB = entriesB.map((e) => e.key).join(",");

    expect(fpA).toBe(fpB);
    expect(fpA).toBe("t2,t1"); // sorted by startedAt desc
  });

  it("fingerprint changes when slots change", () => {
    const buildFingerprint = (slots) =>
      slots
        .map((slot, index) => ({
          key: String(slot?.taskId || slot?.sessionId || `slot-${index}`),
          slot,
          index,
        }))
        .sort((a, b) => {
          const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
          const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
          return bScore - aScore;
        })
        .map((e) => e.key)
        .join(",");

    const fp1 = buildFingerprint([{ taskId: "t1" }]);
    const fp2 = buildFingerprint([{ taskId: "t1" }, { taskId: "t2" }]);
    const fp3 = buildFingerprint([]);

    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp2).not.toBe(fp3);
    expect(fp3).toBe("");
  });

  it("handles empty and null slot arrays gracefully", () => {
    const buildEntries = (slots) =>
      (slots || [])
        .map((slot, index) => ({
          key: String(slot?.taskId || slot?.sessionId || `slot-${index}`),
          slot,
          index,
        }))
        .sort((a, b) => {
          const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
          const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
          return bScore - aScore;
        });

    expect(buildEntries(null)).toEqual([]);
    expect(buildEntries(undefined)).toEqual([]);
    expect(buildEntries([])).toEqual([]);
    expect(buildEntries([{}])).toEqual([{ key: "slot-0", slot: {}, index: 0 }]);
  });

  it("handles rapid add/remove without duplicate keys", () => {
    // Simulates rapid slot changes where slots come and go
    const rounds = [
      [{ taskId: "a" }, { taskId: "b" }],
      [{ taskId: "b" }, { taskId: "c" }],
      [{ taskId: "c" }],
      [],
      [{ taskId: "d" }, { taskId: "e" }, { taskId: "f" }],
    ];

    for (const slots of rounds) {
      const entries = slots.map((slot, index) => ({
        key: String(slot?.taskId || slot?.sessionId || `slot-${index}`),
      }));
      const keys = entries.map((e) => e.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    }
  });
});
