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

const sourceFiles = [
  "ui/tabs/agents.js",
  "site/ui/tabs/agents.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const sessionListSourceFiles = [
  "ui/components/session-list.js",
  "site/ui/components/session-list.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

for (const { relPath, source } of sourceFiles) {
  describe(`FleetSessionsPanel render stability (${relPath})`, () => {
    it("renders a keyboard-accessible session id pill with copy feedback state", () => {
      expect(source).toContain("fleet-session-id-pill");
      expect(source).toContain("type=\"button\"");
      expect(source).toContain("aria-label=${`Copy session ID ${sessionId}`}\");
      expect(source).toContain("data-copied=${copiedSessionId === sessionId ? \"true\" : \"false\"}");
      expect(source).toContain("sessionId.slice(0, 8)");
      expect(source).toContain("copySessionId(sessionId)");
      expect(source).toContain("fleet-session-id-pill-icon");
      expect(source).toContain('copiedSessionId === sessionId ? "✓" : ICONS.copy');
    });
    it("never fabricates session ids for task-only fallback entries", () => {
      expect(source).toContain("function resolveFleetEntrySessionId(entry)");
      expect(source).toContain("if (entry?.isTaskFallback || entry?.slot?.synthetic) return \"\";");
      expect(source).toContain("sessionId: \"\",");
      expect(source).not.toContain("sessionId: String(task?.id || task?.taskId || \"\").trim(),");
    });

    it("treats detached sessions as active based on status, not history-only placement", () => {
      expect(source).toContain("function isFleetEntryActive(entry)");
      expect(source).not.toContain("if (entry.isHistory) return false;");
      expect(source).toContain('return status === "active" || status === "running" || status === "busy" || status === "inprogress";');
    });

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
      // The dep array must START with the fingerprint primitive (other stable
      // primitives like sessionScope may also appear in the array).
      expect(source).toMatch(/\[entriesFingerprint\b/);
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
      const bodyChunk = bodySection.slice(0, 6000);
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
      // Should use a content-derived key (helper or inline expression)
      expect(surroundingChunk).toMatch(/key=\$\{(?:fleetSlotKey\(|slot\?\.taskId)/);
      // Should NOT use key=${i} as the only key
      expect(surroundingChunk).not.toMatch(/key=\$\{i\}\s*\n/);
    });


    it("renders live turn counts in agent cards and exposes the turns detail tab", () => {
      expect(source).toContain("fleet-slot-meta-turns");
      expect(source).toContain("Turns ${Number(entry.session?.turnCount || 0)}");
      expect(source).toContain('detailTab === "turns"');
      expect(source).toContain('iconText(":repeat: Turns")');
      expect(source).toContain("fleet-turn-timeline");
      expect(source).toContain("formatTurnTokens(turn)");
      expect(source).toContain("formatMsDuration(turn.durationMs || 0)");
    });

    it("scopes Fleet metrics to workspace slot summaries and separates session-only activity", () => {
      expect(source).toContain("const workspaceSummary = execData?.workspaceSummary || null;");
      expect(source).not.toContain('loadSessions({ type: "task", workspace: "all" });');
      expect(source).not.toContain("Math.max(activeSlots, activeSessionCount)");
      expect(source).toContain('label: "Dedicated Slots"');
      expect(source).toContain('label: "Session Only"');
      expect(source).toContain('label: "Active Sessions"');
      expect(source).toContain('label: "Workflows"');
      expect(source).toContain("getFleetEntryMetaLabel(entry)");
      expect(source).toContain("getFleetEntryOriginLabel(selectedEntry)");
      expect(source).toContain('return isFleetEntryActive(entry) ? "Session only" : "Session history";');
    });

    it("preserves backend slot indexes when workspace-filtered slots are rendered", () => {
      expect(source).toContain("function resolveFleetSlotIndex(slot, fallbackIndex = 0)");
      expect(source).toContain("resolveFleetSlotIndex(slot, i)");
      expect(source).toContain("index: resolveFleetSlotIndex(slots[slotIndex], slotIndex)");
    });

    it("agent threads list uses stable keys, not array indices", () => {
      // The "Agent Threads" section should key on a stable identifier
      const threadsSection = source.slice(
        source.indexOf("Agent Threads"),
      );
      const statCardChunk = threadsSection.slice(0, 600);
      // Should NOT use key=${i}
      expect(statCardChunk).not.toMatch(/key=\$\{i\}/);
      // Should use a content-derived key (helper or inline expression)
      expect(statCardChunk).toMatch(/key=\$\{(?:fleetThreadKey\(|t\.taskKey)/);
    });
  });
}

for (const { relPath, source } of sessionListSourceFiles) {
  describe(`SessionList stale-data UI parity (${relPath})`, () => {
    it("renders explicit stale-state banner text", () => {
      expect(source).toContain("Session list is showing stale data.");
      expect(source).toContain("Last successful refresh:");
      expect(source).toContain("Freshness:");
      expect(source).toContain("Reason:");
      expect(source).toContain("Refresh request failed");
    });

    it("renders bounded retry status text for countdown and exhaustion", () => {
      expect(source).toContain("Automatic retries stopped after ${loadMeta.maxAttempts} attempts.");
      expect(source).toContain("Retry ${retryAttemptDisplay}/${loadMeta.maxAttempts} in ${retrySeconds}s.");
      expect(source).toContain("disabled=${manualRetryState.disabled}");
      expect(source).toContain("${manualRetryState.label || \"Retry now\"}");
      expect(source).toContain("Manual retry is disabled while automatic backoff is active.");
    });
  });
}

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

describe("executor workspace summary source", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

  it("adds workspace-scoped slot summaries to /api/executor", () => {
    expect(serverSource).toContain("function buildWorkspaceExecutorSummary(execStatus, workspaceContext)");
    expect(serverSource).toContain("const workspaceSummary = execStatus");
    expect(serverSource).toContain("{ ...execStatus, workspaceSummary, activeWorkflowRuns, workflowRunDetails }");
  });

  it("uses the actual request url when augmenting executor workflow counts", () => {
    expect(serverSource).toContain("getWorkflowRequestContext(url, { bootstrapTemplates: false })");
    expect(serverSource).not.toContain("getWorkflowRequestContext(reqUrl, { bootstrapTemplates: false }).catch(() => null);");
  });
});


describe("kanban PR linkage rendering", () => {
  for (const relPath of ["ui/components/kanban-board.js"]) {
    const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
    it(`renders PR linkage source and freshness chips (${relPath})`, () => {
      expect(source).toContain("function getTaskPrLinkage(task)");
      expect(source).toContain("PR source:");
      expect(source).toContain("PR freshness:");
      expect(source).toContain("formatPrLinkageFreshnessLabel");
      expect(source).toContain("Branch: ");
      expect(source).toContain("linkedAt:");
      expect(source).toContain("updatedAt:");
    });

    it(`merges board status updates without shallow-overwriting linkage (${relPath})`, () => {
      const mergeMatches = source.match(/mergeTaskRecords\(t,\s*(?:merged|res\.data)\)/g) || [];
      expect(mergeMatches).toHaveLength(3);
      expect(source).not.toContain("matchTaskId(t.id, taskId) ? { ...t, ...res.data } : t");
    });
  }

  it("merges reload pages without duplicating PR linkage records", async () => {
    const { tasksData, tasksPage, tasksPageSize, loadTasks } = await import("../ui/modules/state.js");
    const originalFetch = globalThis.fetch;
    const responses = [
      {
        ok: true,
        json: async () => ({
          data: [{
            id: "task-1",
            title: "Task 1",
            prLinkage: [{ branchName: "feature/demo", prNumber: 42, prUrl: "https://example.test/pr/42", source: "workflow", freshness: "fresh", updatedAt: "2026-03-22T10:00:00.000Z" }],
            meta: { prLinkage: [{ branchName: "feature/demo", prNumber: 42, prUrl: "https://example.test/pr/42", source: "workflow", freshness: "fresh", updatedAt: "2026-03-22T10:00:00.000Z" }] },
          }],
          total: 1,
          totalPages: 1,
          statusCounts: {},
        }),
      },
      {
        ok: true,
        json: async () => ({
          data: [{
            id: "task-1",
            title: "Task 1 refreshed",
            meta: { prLinkage: [{ branchName: "feature/demo", prNumber: 42, prUrl: "https://example.test/pr/42", source: "auto-load", freshness: "fresh", updatedAt: "2026-03-22T10:05:00.000Z" }] },
          }],
          total: 1,
          totalPages: 1,
          statusCounts: {},
        }),
      },
    ];
    globalThis.fetch = async () => responses.shift();
    tasksPage.value = 0;
    tasksPageSize.value = 25;
    tasksData.value = [];
    try {
      await loadTasks();
      await loadTasks({ append: true });
      expect(tasksData.value).toHaveLength(1);
      expect(tasksData.value[0].meta.prLinkage).toHaveLength(1);
      expect(tasksData.value[0].prLinkage).toHaveLength(1);
      expect(tasksData.value[0].meta.prLinkage[0]).toMatchObject({ prNumber: 42, branchName: "feature/demo", source: "auto-load", freshness: "fresh", updatedAt: "2026-03-22T10:05:00.000Z" });
      expect(tasksData.value[0].branchName).toBe("feature/demo");
      expect(tasksData.value[0].prNumber).toBe(42);
      expect(tasksData.value[0].prUrl).toBe("https://example.test/pr/42");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves canonical linkage fields across non-append reloads", async () => {
    const { tasksData, tasksPage, tasksPageSize, loadTasks } = await import("../ui/modules/state.js");
    const originalFetch = globalThis.fetch;
    const responses = [
      {
        ok: true,
        json: async () => ({
          data: [{
            id: "task-2",
            title: "Task 2 refreshed",
            meta: {
              prLinkage: [{
                branchName: "feature/reload-only",
                prNumber: 84,
                prUrl: "https://example.test/pr/84",
                source: "auto-load",
                freshness: "fresh",
                updatedAt: "2026-03-22T11:05:00.000Z",
              }],
            },
          }],
          total: 1,
          totalPages: 1,
          statusCounts: {},
        }),
      },
    ];
    globalThis.fetch = async () => responses.shift();
    tasksPage.value = 0;
    tasksPageSize.value = 25;
    tasksData.value = [{
      id: "task-2",
      title: "Task 2",
      branchName: "feature/reload-only",
      prNumber: 84,
      prUrl: "https://example.test/pr/84",
      prLinkage: [{
        branchName: "feature/reload-only",
        prNumber: 84,
        prUrl: "https://example.test/pr/84",
        source: "workflow",
        freshness: "fresh",
        updatedAt: "2026-03-22T11:00:00.000Z",
      }],
      meta: {
        prLinkage: [{
          branchName: "feature/reload-only",
          prNumber: 84,
          prUrl: "https://example.test/pr/84",
          source: "workflow",
          freshness: "fresh",
          updatedAt: "2026-03-22T11:00:00.000Z",
        }],
        prLinkageSource: "workflow",
        prLinkageFreshness: "fresh",
        prLinkageUpdatedAt: "2026-03-22T11:00:00.000Z",
      },
    }];
    try {
      await loadTasks();
      expect(tasksData.value).toHaveLength(1);
      expect(tasksData.value[0].prLinkage).toHaveLength(1);
      expect(tasksData.value[0].meta.prLinkage).toHaveLength(1);
      expect(tasksData.value[0].branchName).toBe("feature/reload-only");
      expect(tasksData.value[0].prNumber).toBe(84);
      expect(tasksData.value[0].prUrl).toBe("https://example.test/pr/84");
      expect(tasksData.value[0].meta.prLinkage[0]).toMatchObject({
        branchName: "feature/reload-only",
        prNumber: 84,
        prUrl: "https://example.test/pr/84",
        source: "auto-load",
        freshness: "fresh",
        updatedAt: "2026-03-22T11:05:00.000Z",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
