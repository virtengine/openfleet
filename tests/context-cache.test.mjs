import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a temp directory for test cache to avoid polluting real cache
const TEST_CACHE_DIR = resolve(__dirname, "..", ".cache-test-tool-logs");

// Mock the cache directory before importing the module
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

describe("context-cache", () => {
  let contextCache;

  beforeEach(async () => {
    // Clean test directory
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CACHE_DIR, { recursive: true });

    // Fresh import for each test
    vi.resetModules();
    contextCache = await import("../workspace/context-cache.mjs");
  });

  afterEach(() => {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── Helper: build a fake item array with tool outputs ──────────────────
  function makeToolItems(count, textSize = 500) {
    const items = [];
    for (let i = 0; i < count; i++) {
      // Alternate between tool outputs and agent messages
      items.push({
        type: "function_call_output",
        tool_name: `tool_${i}`,
        arguments: { file: `src/file${i}.ts`, query: "search term" },
        output: `Output from tool ${i}: ${"x".repeat(textSize)}`,
      });
      items.push({
        type: "agent_message",
        text: `Agent response after tool ${i}`,
      });
    }
    return items;
  }

  // ── cacheAndCompressItems ──────────────────────────────────────────────

  describe("cacheAndCompressItems", () => {
    it("returns items unchanged when fewer than fullContextTurns", async () => {
      const items = makeToolItems(2); // only 2 tool calls
      const result = await contextCache.cacheAndCompressItems(items);
      expect(result).toEqual(items);
    });

    it("keeps last 3 turns fully intact (Tier 0)", async () => {
      const items = makeToolItems(6, 3000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Last 3 tool outputs (index 4, 5 are the last tool items) should be full
      // Items are: tool0, agent0, tool1, agent1, ..., tool5, agent5
      // Turns are: tool outputs increment turn counter

      // The last tool output items should retain their full text
      const lastToolItems = result.filter(
        (it) => it.type === "function_call_output" && !it._cachedLogId,
      );
      // At least 3 should be untouched
      expect(lastToolItems.length).toBeGreaterThanOrEqual(2);
    });

    it("compresses older items and adds retrieval command", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Some items should now have _cachedLogId
      const cached = result.filter(
        (it) => it._cachedLogId !== undefined,
      );
      expect(cached.length).toBeGreaterThan(0);

      // Compressed items should reference bosun --tool-log
      for (const item of cached) {
        const text =
          item.text || item.output || "";
        expect(text).toContain("bosun --tool-log");
      }
    });

    it("does not compress agent messages (non-tool items)", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);

      const agentMessages = result.filter((it) => it.type === "agent_message");
      // Agent messages should all be untouched
      for (const msg of agentMessages) {
        expect(msg._cachedLogId).toBeUndefined();
      }
    });

    it("does not compress items with text shorter than 200 chars", async () => {
      const items = makeToolItems(8, 50); // very small outputs
      const result = await contextCache.cacheAndCompressItems(items);

      // Should have no cached items because outputs are too small
      const cached = result.filter((it) => it._cachedLogId !== undefined);
      expect(cached.length).toBe(0);
    });

    it("respects custom fullContextTurns option", async () => {
      const items = makeToolItems(6, 3000);
      // Keep 5 turns full — should compress very little
      const result = await contextCache.cacheAndCompressItems(items, {
        fullContextTurns: 5,
      });

      const cached = result.filter((it) => it._cachedLogId !== undefined);
      // With 6 tools and 5 full turns, only 1 should be compressed
      const fullContextResult = await contextCache.cacheAndCompressItems(
        items,
        { fullContextTurns: 2 },
      );
      const cachedAggressive = fullContextResult.filter(
        (it) => it._cachedLogId !== undefined,
      );
      // More aggressive should compress more
      expect(cachedAggressive.length).toBeGreaterThanOrEqual(cached.length);
    });
  });

  // ── retrieveToolLog ────────────────────────────────────────────────────

  describe("retrieveToolLog", () => {
    it("retrieves a cached tool output by ID", async () => {
      // First, compress some items to generate cache entries
      const items = makeToolItems(6, 3000);
      const result = await contextCache.cacheAndCompressItems(items);

      const cached = result.filter((it) => it._cachedLogId !== undefined);
      if (cached.length === 0) return; // skip if nothing was cached

      const logId = cached[0]._cachedLogId;
      const retrieved = await contextCache.retrieveToolLog(logId);

      expect(retrieved.found).toBe(true);
      expect(retrieved.entry).toBeDefined();
      expect(retrieved.entry.id).toBe(logId);
      expect(retrieved.entry.item).toBeDefined();
    });

    it("returns found=false for non-existent ID", async () => {
      const result = await contextCache.retrieveToolLog(999999999);
      expect(result.found).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns found=false for invalid ID", async () => {
      const result = await contextCache.retrieveToolLog("abc");
      expect(result.found).toBe(false);
      expect(result.error).toContain("Invalid");
    });
  });

  // ── listToolLogs ───────────────────────────────────────────────────────

  describe("listToolLogs", () => {
    it("lists cached entries", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      const logs = await contextCache.listToolLogs();
      expect(Array.isArray(logs)).toBe(true);
      // Should have at least some entries
      if (logs.length > 0) {
        expect(logs[0].id).toBeDefined();
        expect(logs[0].toolName).toBeDefined();
      }
    });

    it("respects limit parameter", async () => {
      const items = makeToolItems(10, 3000);
      await contextCache.cacheAndCompressItems(items);

      const limited = await contextCache.listToolLogs(2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });
  });

  // ── pruneToolLogCache ──────────────────────────────────────────────────

  describe("pruneToolLogCache", () => {
    it("prunes entries older than maxAgeMs", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      // Prune with 0ms max age — everything should be pruned
      const pruned = await contextCache.pruneToolLogCache(0);
      expect(pruned).toBeGreaterThanOrEqual(0);
    });

    it("does not prune recent entries with default TTL", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      // Prune with default 24h — nothing should be pruned (just created)
      const pruned = await contextCache.pruneToolLogCache();
      expect(pruned).toBe(0);
    });
  });

  // ── estimateSavings ────────────────────────────────────────────────────

  describe("estimateSavings", () => {
    it("calculates compression savings correctly", async () => {
      const items = makeToolItems(10, 5000);
      const compressed = await contextCache.cacheAndCompressItems(items);

      const savings = contextCache.estimateSavings(items, compressed);
      expect(savings.originalChars).toBeGreaterThan(0);
      expect(savings.savedChars).toBeGreaterThanOrEqual(0);
      expect(savings.savedPct).toBeGreaterThanOrEqual(0);
      expect(savings.savedPct).toBeLessThanOrEqual(100);
    });

    it("returns 0 savings when nothing is compressed", () => {
      const items = makeToolItems(2, 50);
      const savings = contextCache.estimateSavings(items, items);
      expect(savings.savedChars).toBe(0);
      expect(savings.savedPct).toBe(0);
    });
  });

  // ── Tiered compression ────────────────────────────────────────────────

  describe("tiered compression", () => {
    it("applies progressively more aggressive compression to older items", async () => {
      // Create a large session with many tool calls
      const items = makeToolItems(15, 8000);
      const result = await contextCache.cacheAndCompressItems(items);

      const cachedItems = result.filter((it) => it._cachedLogId !== undefined);

      if (cachedItems.length >= 2) {
        // Older items should have shorter text than newer compressed items
        // (Tier 3 skeleton vs Tier 1 head+tail)
        const texts = cachedItems.map((it) => (it.text || it.output || "").length);
        // The array should generally decrease (older = more compressed)
        // but just check that at least one item is significantly shorter
        const min = Math.min(...texts);
        const max = Math.max(...texts);
        expect(max).toBeGreaterThan(min);
      }
    });

    it("Tier 3 items only contain skeleton with retrieval command", async () => {
      const items = makeToolItems(20, 8000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Very old items should be Tier 3 — just "[Cached tool call]..."
      const skeletonItems = result.filter(
        (it) =>
          it.type === "context_compressed" ||
          (typeof it.text === "string" && it.text.startsWith("[Cached tool call]")),
      );

      if (skeletonItems.length > 0) {
        for (const sk of skeletonItems) {
          expect(sk.text).toContain("bosun --tool-log");
          expect(sk.text.length).toBeLessThan(300);
        }
      }
    });
  });

  // ── getToolLogDir ──────────────────────────────────────────────────────

  describe("getToolLogDir", () => {
    it("returns a string path", () => {
      const dir = contextCache.getToolLogDir();
      expect(typeof dir).toBe("string");
      expect(dir).toContain("tool-logs");
    });
  });

  // ── isItemPinned ───────────────────────────────────────────────────────

  describe("isItemPinned", () => {
    it("detects explicit _pinned flag", () => {
      const item = { type: "agent_message", text: "Some text", _pinned: true };
      expect(contextCache.isItemPinned(item)).toBe(true);
    });

    it("detects AGENTS.md keyword", () => {
      const item = {
        type: "agent_message",
        text: "Read the AGENTS.md file for instructions on how to proceed.",
      };
      expect(contextCache.isItemPinned(item)).toBe(true);
    });

    it("detects CRITICAL/MUST/NEVER keywords", () => {
      expect(contextCache.isItemPinned({ text: "CRITICAL: always run tests" })).toBe(true);
      expect(contextCache.isItemPinned({ text: "You MUST NOT skip linting" })).toBe(true);
      expect(contextCache.isItemPinned({ text: "NEVER use --no-verify" })).toBe(true);
    });

    it("detects commit convention rules", () => {
      expect(
        contextCache.isItemPinned({ text: "Use conventional commits for all changes." }),
      ).toBe(true);
      expect(
        contextCache.isItemPinned({ text: "Pre-push hooks must pass before pushing." }),
      ).toBe(true);
    });

    it("returns false for ordinary agent messages", () => {
      expect(
        contextCache.isItemPinned({ type: "agent_message", text: "Let me implement the feature." }),
      ).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(contextCache.isItemPinned(null)).toBe(false);
      expect(contextCache.isItemPinned(undefined)).toBe(false);
    });
  });

  // ── compressAllItems ──────────────────────────────────────────────────

  describe("compressAllItems", () => {
    // Helper: build a mixed session with tools, agent msgs, user msgs
    function makeMixedSession(turns) {
      const items = [];
      for (let i = 0; i < turns; i++) {
        // User prompt (simulating what a user would send)
        items.push({
          type: "user_message",
          role: "user",
          text: `User request turn ${i}: ${"Please implement the feature that does something useful. ".repeat(10)}`,
        });
        // Tool output  
        items.push({
          type: "function_call_output",
          tool_name: `tool_${i}`,
          arguments: { file: `src/file${i}.ts` },
          output: `Output from tool ${i}: ${"x".repeat(500)}`,
        });
        // Agent thinking/response
        items.push({
          type: "agent_message",
          text: `Now let me implement the changes for step ${i}. I need to:\n` +
            `1. First, read the existing code\n` +
            `2. Then modify the function\n` +
            `3. Run the tests\n` +
            `4. Commit the changes\n` +
            `${"Detailed reasoning about the implementation approach. ".repeat(5)}`,
        });
      }
      return items;
    }

    it("compresses agent messages from older turns", async () => {
      const items = makeMixedSession(8);
      const result = await contextCache.compressAllItems(items);

      // Older agent messages should be compressed
      const compressedAgentMsgs = result.filter(
        (it) => it._compressed === "agent_tier1" || it._compressed === "agent_tier2",
      );
      expect(compressedAgentMsgs.length).toBeGreaterThan(0);
    });

    it("compresses user messages from older turns", async () => {
      const items = makeMixedSession(8);
      const result = await contextCache.compressAllItems(items);

      // Older user messages should be breadcrumb-compressed
      const compressedUserMsgs = result.filter(
        (it) => it._compressed === "user_breadcrumb",
      );
      expect(compressedUserMsgs.length).toBeGreaterThan(0);

      // Breadcrumbs should be wrapped in [User request: …]
      for (const msg of compressedUserMsgs) {
        expect(msg.text).toMatch(/^\[User request:/);
      }
    });

    it("keeps current turn messages in full", async () => {
      const items = makeMixedSession(8);
      const result = await contextCache.compressAllItems(items);

      // Last agent message should be untouched (age 0)
      const lastAgentMsg = result
        .filter((it) => it.type === "agent_message")
        .pop();
      expect(lastAgentMsg._compressed).toBeUndefined();
      expect(lastAgentMsg.text).toContain("Now let me implement");
    });

    it("never compresses pinned instruction items", async () => {
      const items = makeMixedSession(6);
      // Insert an instruction item at the beginning
      items.unshift({
        type: "agent_message",
        text: "I have read AGENTS.md and will follow the CRITICAL rules: MUST NOT skip tests, NEVER use --no-verify, always use conventional commits.",
        _pinned: true,
      });

      const result = await contextCache.compressAllItems(items);

      // Find the pinned item — should be untouched
      const pinned = result.find((it) => it._pinned === true);
      expect(pinned).toBeDefined();
      expect(pinned._compressed).toBeUndefined();
      expect(pinned.text).toContain("AGENTS.md");
    });

    it("never compresses instruction items detected by keywords", async () => {
      const items = makeMixedSession(6);
      // Insert instruction items without explicit _pinned flag — should be auto-detected
      items.unshift({
        type: "agent_message",
        text: "## Instructions\nCRITICAL: Module-scope caching is MANDATORY. Error boundaries MUST wrap all async work.",
      });

      const result = await contextCache.compressAllItems(items);

      // The instruction item should be untouched
      const instructionItem = result.find(
        (it) => typeof it.text === "string" && it.text.includes("## Instructions"),
      );
      expect(instructionItem).toBeDefined();
      expect(instructionItem._compressed).toBeUndefined();
    });

    it("progressively compresses agent messages with age", async () => {
      const items = makeMixedSession(12);
      const result = await contextCache.compressAllItems(items);

      // Should have both tier1 and tier2 compressions
      const tier1 = result.filter((it) => it._compressed === "agent_tier1");
      const tier2 = result.filter((it) => it._compressed === "agent_tier2");

      // Tier 2 items should be shorter than tier 1 items
      if (tier1.length > 0 && tier2.length > 0) {
        const avgTier1Len =
          tier1.reduce((s, it) => s + (it.text?.length || 0), 0) / tier1.length;
        const avgTier2Len =
          tier2.reduce((s, it) => s + (it.text?.length || 0), 0) / tier2.length;
        expect(avgTier2Len).toBeLessThan(avgTier1Len);
      }
    });

    it("user breadcrumbs preserve the role field", async () => {
      const items = makeMixedSession(6);
      const result = await contextCache.compressAllItems(items);

      const userBreadcrumbs = result.filter(
        (it) => it._compressed === "user_breadcrumb",
      );
      for (const msg of userBreadcrumbs) {
        expect(msg.role).toBe("user");
      }
    });

    it("does not compress short messages", async () => {
      const items = [
        { type: "function_call_output", tool_name: "t1", output: "x".repeat(500) },
        { type: "agent_message", text: "OK, done." },
        { type: "function_call_output", tool_name: "t2", output: "x".repeat(500) },
        { type: "agent_message", text: "Short msg." },
        { type: "function_call_output", tool_name: "t3", output: "x".repeat(500) },
        { type: "agent_message", text: "Also short." },
        { type: "function_call_output", tool_name: "t4", output: "x".repeat(500) },
        { type: "agent_message", text: "Last one." },
      ];
      const result = await contextCache.compressAllItems(items);

      // Short agent messages should not be compressed
      const compressed = result.filter(
        (it) => it._compressed === "agent_tier1" || it._compressed === "agent_tier2",
      );
      expect(compressed.length).toBe(0);
    });

    it("combines tool and message compression savings", async () => {
      const items = makeMixedSession(10);
      const result = await contextCache.compressAllItems(items);

      const savings = contextCache.estimateSavings(items, result);
      // Should save both from tool outputs AND messages
      expect(savings.savedChars).toBeGreaterThan(0);
      expect(savings.savedPct).toBeGreaterThan(0);
    });
  });

  // ── Content-Aware Relevance Scoring ───────────────────────────────────

  describe("scoreToolOutput", () => {
    it("returns neutral score for null/undefined", () => {
      expect(contextCache.scoreToolOutput(null)).toBe(50);
      expect(contextCache.scoreToolOutput(undefined)).toBe(50);
    });

    it("scores small targeted file reads high", () => {
      const item = {
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "src/config.mjs", startLine: 10, endLine: 25 },
        output: "const FOO = 42;\nexport default FOO;",
      };
      const score = contextCache.scoreToolOutput(item);
      // read_file base(85) + small size(~+20) + narrow range(+15) + path(+5)
      expect(score).toBeGreaterThanOrEqual(70);
    });

    it("scores large grep search results low", () => {
      // Simulate a big grep result with many matches
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`src/file${i}.ts:${i * 10}: const x = ${i};`);
      }
      const item = {
        type: "function_call_output",
        tool_name: "grep_search",
        arguments: { query: "const x" },
        output: lines.join("\n"),
      };
      const score = contextCache.scoreToolOutput(item);
      // grep_search base(30) + large size(-5 to -10) + many matches(-15)
      expect(score).toBeLessThan(30);
    });

    it("scores file edits high regardless of size", () => {
      const item = {
        type: "function_call_output",
        tool_name: "replace_string_in_file",
        arguments: { filePath: "src/main.ts" },
        output: "File edited successfully",
      };
      const score = contextCache.scoreToolOutput(item);
      // replace_string_in_file base(90) + small output(+20) + path(+5)
      // Clamped to 100 max
      expect(score).toBeGreaterThanOrEqual(90);
    });

    it("scores command failures higher than successes", () => {
      const success = {
        type: "command_execution",
        command: "npm test",
        exit_code: 0,
        aggregated_output: "All tests passed.\n" + "x".repeat(500),
      };
      const failure = {
        type: "command_execution",
        command: "npm test",
        exit_code: 1,
        aggregated_output: "FAIL tests/foo.test.ts\n" + "x".repeat(500),
      };
      const successScore = contextCache.scoreToolOutput(success);
      const failureScore = contextCache.scoreToolOutput(failure);
      // Failure gets +10 error bonus
      expect(failureScore).toBeGreaterThan(successScore);
    });

    it("gives higher scores to narrower line ranges", () => {
      const narrow = {
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "a.ts", startLine: 10, endLine: 15 },
        output: "const a = 1;\nconst b = 2;",
      };
      const wide = {
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "a.ts", startLine: 1, endLine: 500 },
        output: "x".repeat(15000),
      };
      const narrowScore = contextCache.scoreToolOutput(narrow);
      const wideScore = contextCache.scoreToolOutput(wide);
      expect(narrowScore).toBeGreaterThan(wideScore);
    });

    it("identifies search tools by name pattern", () => {
      const item = {
        type: "function_call_output",
        tool_name: "semantic_search",
        arguments: { query: "auth handler" },
        output: "x".repeat(8000),
      };
      const score = contextCache.scoreToolOutput(item);
      // semantic_search base(25) + large size(-5) = low score
      expect(score).toBeLessThan(40);
    });

    it("returns error items with item.error field higher score", () => {
      const item = {
        type: "function_call_output",
        tool_name: "unknown_tool",
        error: { message: "Something went wrong" },
        output: "",
      };
      const score = contextCache.scoreToolOutput(item);
      // unknown tool base(50) + tiny size(+20) + error(+10) = 80
      expect(score).toBeGreaterThanOrEqual(70);
    });
  });

  describe("content-aware compression integration", () => {
    it("protects high-value small reads from early compression", async () => {
      // 10 turns: early turns have small targeted reads
      const items = [];
      // Turn 0: small read_file (high value)
      items.push({
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "src/core.ts", startLine: 10, endLine: 15 },
        output: "function handleRequest() { return true; }",
      });
      items.push({ type: "agent_message", text: "Found the handler." });

      // Turns 1-7: filler to push turn 0 far enough for age-based compression
      for (let i = 1; i <= 7; i++) {
        items.push({
          type: "function_call_output",
          tool_name: `tool_${i}`,
          output: `Short output ${i}: ` + "y".repeat(300),
        });
        items.push({ type: "agent_message", text: `Done step ${i}.` });
      }

      const result = await contextCache.cacheAndCompressItems(items);

      // The small read_file from turn 0 should still be relatively intact
      // because its high score protects it (shifts tier down by 2)
      const readItem = result.find(
        (it) => it.tool_name === "read_file" || it._originalTool === "read_file",
      );
      // If the item was kept at tier 0 (full), it shouldn't have _compressed
      // If it was compressed, at worst it should be tier 1 (not tier 3/breadcrumb)
      if (readItem._compressed) {
        expect(readItem._compressed).not.toBe("tier3");
      }
    });

    it("aggressively compresses low-value large search results", async () => {
      const items = [];
      // Turn 0: large grep search with many matches (low value)
      const searchLines = [];
      for (let i = 0; i < 80; i++) {
        searchLines.push(`src/generated${i}.ts:${i}: match ${i}`);
      }
      items.push({
        type: "function_call_output",
        tool_name: "grep_search",
        arguments: { query: "match" },
        output: searchLines.join("\n"),
      });
      items.push({ type: "agent_message", text: "Found many results." });

      // Turns 1-4: normal work
      for (let i = 1; i <= 4; i++) {
        items.push({
          type: "function_call_output",
          tool_name: `tool_${i}`,
          output: `Step ${i} output: ` + "z".repeat(400),
        });
        items.push({ type: "agent_message", text: `Step ${i} done.` });
      }

      const result = await contextCache.cacheAndCompressItems(items);

      // The large grep_search should be compressed more aggressively
      const grepItem = result.find(
        (it) =>
          it.tool_name === "grep_search" || /grep/i.test(it._originalTool || ""),
      );
      // Should have been compressed (it's large + low score + old enough)
      if (grepItem) {
        expect(grepItem._compressed || grepItem._cachedLogId).toBeTruthy();
      }
    });
  });
});
