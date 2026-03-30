/**
 * @module tests/hook-library.test.mjs
 * @description Unit tests for the hook library system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getHookCatalog,
  getCoreHooks,
  getDefaultHooks,
  getHookById,
  getHookCategories,
  getSdkCompatibilityMatrix,
  getSdkSupportLevel,
  getHookCompatibility,
  SDK_CAPABILITIES,
  HOOK_CATEGORIES,
  BUILTIN_HOOKS,
  loadHookState,
  saveHookState,
  initializeHookState,
  enableHook,
  disableHook,
  getEnabledHookIds,
  getEnabledHooks,
  getHooksForRegistration,
  getHooksAsLibraryEntries,
  syncHooksToLibrary,
} from "../agent/hook-library.mjs";

import {
  registerHook,
  resetHooks,
  registerLibraryHooks,
  getRegisteredHooks,
  HOOK_EVENTS,
} from "../agent/agent-hooks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(__dirname, "..", ".cache", "test-hook-library");

describe("hook-library", () => {
  beforeEach(() => {
    mkdirSync(resolve(testDir, ".bosun"), { recursive: true });
    resetHooks();
  });

  afterEach(() => {
    resetHooks();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  // ── Catalog ─────────────────────────────────────────────────────────────

  describe("getHookCatalog()", () => {
    it("returns all built-in hooks with compatibility info", () => {
      const catalog = getHookCatalog();
      expect(catalog.length).toBeGreaterThanOrEqual(30);
      for (const hook of catalog) {
        expect(hook).toHaveProperty("id");
        expect(hook).toHaveProperty("name");
        expect(hook).toHaveProperty("description");
        expect(hook).toHaveProperty("category");
        expect(hook).toHaveProperty("events");
        expect(hook).toHaveProperty("command");
        expect(hook).toHaveProperty("compatibility");
        expect(typeof hook.compatibility).toBe("object");
        expect(Object.keys(hook.compatibility)).toEqual(
          expect.arrayContaining(["codex", "copilot", "claude", "gemini", "opencode"]),
        );
      }
    });

    it("filters by category", () => {
      const core = getHookCatalog({ category: "core" });
      expect(core.length).toBeGreaterThan(0);
      for (const h of core) {
        expect(h.category).toBe("core");
      }

      const safety = getHookCatalog({ category: "safety" });
      expect(safety.length).toBeGreaterThan(0);
      for (const h of safety) {
        expect(h.category).toBe("safety");
      }
    });

    it("filters core-only hooks", () => {
      const core = getHookCatalog({ coreOnly: true });
      expect(core.length).toBeGreaterThan(0);
      for (const h of core) {
        expect(h.core).toBe(true);
      }
    });

    it("filters default-enabled hooks", () => {
      const defaults = getHookCatalog({ defaultOnly: true });
      expect(defaults.length).toBeGreaterThan(0);
      for (const h of defaults) {
        expect(h.defaultEnabled).toBe(true);
      }
    });

    it("filters by SDK compatibility", () => {
      const codexHooks = getHookCatalog({ sdk: "codex" });
      expect(codexHooks.length).toBeGreaterThan(0);
      for (const h of codexHooks) {
        expect(h.compatibility.codex).not.toBe("unsupported");
      }
    });

    it("filters by search text", () => {
      const results = getHookCatalog({ search: "force push" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((h) => h.id === "safety-block-force-push")).toBe(true);
    });

    it("returns empty for nonexistent category", () => {
      expect(getHookCatalog({ category: "nonexistent" })).toEqual([]);
    });
  });

  describe("getCoreHooks()", () => {
    it("returns only core hooks", () => {
      const core = getCoreHooks();
      expect(core.length).toBeGreaterThanOrEqual(5);
      for (const h of core) {
        expect(h.core).toBe(true);
        expect(h.disableWarning).toBeTruthy();
      }
    });
  });

  describe("getDefaultHooks()", () => {
    it("returns all default-enabled hooks including core and recommended", () => {
      const defaults = getDefaultHooks();
      expect(defaults.length).toBeGreaterThan(getCoreHooks().length);
      // All core hooks should be default-enabled
      const coreIds = getCoreHooks().map((h) => h.id);
      const defaultIds = defaults.map((h) => h.id);
      for (const id of coreIds) {
        expect(defaultIds).toContain(id);
      }
    });
  });

  describe("getHookById()", () => {
    it("returns a hook with compatibility info", () => {
      const hook = getHookById("core-session-heartbeat");
      expect(hook).not.toBeNull();
      expect(hook.id).toBe("core-session-heartbeat");
      expect(hook.core).toBe(true);
      expect(hook.compatibility).toBeDefined();
    });

    it("returns null for unknown hook", () => {
      expect(getHookById("nonexistent-hook")).toBeNull();
    });
  });

  describe("getHookCategories()", () => {
    it("returns categories with counts", () => {
      const categories = getHookCategories();
      expect(categories.length).toBe(HOOK_CATEGORIES.length);
      for (const cat of categories) {
        expect(cat).toHaveProperty("id");
        expect(cat).toHaveProperty("name");
        expect(cat).toHaveProperty("count");
        expect(cat).toHaveProperty("coreCount");
        expect(typeof cat.count).toBe("number");
      }
      // Core category should have multiple hooks
      const coreCategory = categories.find((c) => c.id === "core");
      expect(coreCategory.count).toBeGreaterThanOrEqual(5);
      expect(coreCategory.coreCount).toBeGreaterThanOrEqual(5);
    });
  });

  // ── SDK Compatibility ─────────────────────────────────────────────────────

  describe("SDK_CAPABILITIES", () => {
    it("defines all five SDKs", () => {
      expect(Object.keys(SDK_CAPABILITIES)).toEqual(
        expect.arrayContaining(["codex", "copilot", "claude", "gemini", "opencode"]),
      );
    });

    it("each SDK has required fields", () => {
      for (const [id, sdk] of Object.entries(SDK_CAPABILITIES)) {
        expect(sdk.id).toBe(id);
        expect(sdk.name).toBeTruthy();
        expect(Array.isArray(sdk.nativeEvents)).toBe(true);
        expect(Array.isArray(sdk.bridgeEvents)).toBe(true);
        expect(sdk.configPath).toBeTruthy();
      }
    });
  });

  describe("getSdkSupportLevel()", () => {
    it("returns 'full' for codex native events", () => {
      expect(getSdkSupportLevel("codex", "SessionStart")).toBe("full");
      expect(getSdkSupportLevel("codex", "PreToolUse")).toBe("full");
    });

    it("returns 'bridge' for codex bridge events", () => {
      expect(getSdkSupportLevel("codex", "PrePush")).toBe("bridge");
      expect(getSdkSupportLevel("codex", "TaskComplete")).toBe("bridge");
    });

    it("returns 'unsupported' for gemini SubagentStart", () => {
      expect(getSdkSupportLevel("gemini", "SubagentStart")).toBe("unsupported");
    });

    it("returns 'unsupported' for unknown SDK", () => {
      expect(getSdkSupportLevel("unknown-sdk", "SessionStart")).toBe("unsupported");
    });

    it("returns 'unsupported' for opencode PR events", () => {
      expect(getSdkSupportLevel("opencode", "PrePR")).toBe("unsupported");
      expect(getSdkSupportLevel("opencode", "PostPR")).toBe("unsupported");
    });
  });

  describe("getSdkCompatibilityMatrix()", () => {
    it("returns matrix for all hooks", () => {
      const matrix = getSdkCompatibilityMatrix();
      expect(Object.keys(matrix).length).toBe(BUILTIN_HOOKS.length);
      for (const [hookId, compat] of Object.entries(matrix)) {
        expect(compat).toHaveProperty("codex");
        expect(compat).toHaveProperty("copilot");
        expect(compat).toHaveProperty("claude");
        expect(compat).toHaveProperty("gemini");
        expect(compat).toHaveProperty("opencode");
      }
    });
  });

  describe("getHookCompatibility()", () => {
    it("computes correct compatibility for single-event hook", () => {
      const hook = BUILTIN_HOOKS.find((h) => h.id === "core-session-heartbeat");
      const compat = getHookCompatibility(hook);
      // PostToolUse is native for codex + claude, bridge for others
      expect(compat.codex).toBe("full");
      expect(compat.claude).toBe("full");
      expect(compat.copilot).toBe("bridge");
    });

    it("computes correct compatibility for multi-event hook", () => {
      const hook = BUILTIN_HOOKS.find((h) => h.id === "session-git-status-snapshot");
      expect(hook.events).toEqual(["SessionStart", "SessionStop"]);
      const compat = getHookCompatibility(hook);
      // Both events are native for codex
      expect(compat.codex).toBe("full");
    });

    it("marks PR hooks as unsupported for opencode", () => {
      const hook = BUILTIN_HOOKS.find((h) => h.id === "notify-pr-created-log");
      const compat = getHookCompatibility(hook);
      expect(compat.opencode).toBe("unsupported");
    });
  });

  // ── Hook State (workspace-scoped enable/disable) ──────────────────────────

  describe("loadHookState()", () => {
    it("returns empty state for fresh directory", () => {
      const state = loadHookState(testDir);
      expect(state.enabled).toEqual({});
      expect(state.updatedAt).toBeTruthy();
    });

    it("returns saved state after save", () => {
      saveHookState(testDir, { enabled: { "test-hook": true }, updatedAt: "now" });
      const state = loadHookState(testDir);
      expect(state.enabled["test-hook"]).toBe(true);
    });
  });

  describe("initializeHookState()", () => {
    it("enables all default hooks", () => {
      const state = initializeHookState(testDir);
      const defaults = getDefaultHooks();
      for (const hook of defaults) {
        expect(state.enabled[hook.id]).toBe(true);
      }
    });

    it("does not override existing enabled settings", () => {
      // Pre-disable a default hook
      saveHookState(testDir, {
        enabled: { "core-session-heartbeat": false },
        updatedAt: "old",
      });
      const state = initializeHookState(testDir);
      // Should NOT override the explicit false
      expect(state.enabled["core-session-heartbeat"]).toBe(false);
    });
  });

  describe("enableHook()", () => {
    it("enables a valid hook", () => {
      const result = enableHook(testDir, "safety-block-force-push");
      expect(result.success).toBe(true);
      const ids = getEnabledHookIds(testDir);
      expect(ids).toContain("safety-block-force-push");
    });

    it("returns error for unknown hook", () => {
      const result = enableHook(testDir, "nonexistent");
      expect(result.success).toBe(false);
    });
  });

  describe("disableHook()", () => {
    it("disables non-core hook without warning", () => {
      enableHook(testDir, "safety-block-force-push");
      const result = disableHook(testDir, "safety-block-force-push");
      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it("rejects disabling core hook without force", () => {
      enableHook(testDir, "core-session-heartbeat");
      const result = disableHook(testDir, "core-session-heartbeat");
      expect(result.success).toBe(false);
      expect(result.warning).toBeTruthy();
      // Hook should still be enabled
      const ids = getEnabledHookIds(testDir);
      expect(ids).toContain("core-session-heartbeat");
    });

    it("allows disabling core hook with force=true", () => {
      enableHook(testDir, "core-session-heartbeat");
      const result = disableHook(testDir, "core-session-heartbeat", true);
      expect(result.success).toBe(true);
      expect(result.warning).toBeTruthy(); // Still shows warning
    });

    it("returns error for unknown hook", () => {
      const result = disableHook(testDir, "nonexistent");
      expect(result.success).toBe(false);
    });
  });

  describe("getEnabledHooks()", () => {
    it("returns full hook entries for enabled hooks", () => {
      initializeHookState(testDir);
      const hooks = getEnabledHooks(testDir);
      expect(hooks.length).toBeGreaterThan(0);
      for (const h of hooks) {
        expect(h).toHaveProperty("id");
        expect(h).toHaveProperty("compatibility");
      }
    });
  });

  // ── Registration Bridge ───────────────────────────────────────────────────

  describe("getHooksForRegistration()", () => {
    it("groups enabled hooks by event", () => {
      initializeHookState(testDir);
      const byEvent = getHooksForRegistration(testDir);
      expect(typeof byEvent).toBe("object");
      // Should have entries for events that default hooks cover
      expect(Object.keys(byEvent).length).toBeGreaterThan(0);
      for (const [event, hooks] of Object.entries(byEvent)) {
        expect(HOOK_EVENTS).toContain(event);
        expect(Array.isArray(hooks)).toBe(true);
        for (const h of hooks) {
          expect(h).toHaveProperty("id");
          expect(h).toHaveProperty("command");
        }
      }
    });
  });

  describe("registerLibraryHooks()", () => {
    it("registers hooks from library into agent-hooks runtime", () => {
      initializeHookState(testDir);
      const byEvent = getHooksForRegistration(testDir);
      const result = registerLibraryHooks(byEvent);
      expect(result.registered).toBeGreaterThan(0);

      // Verify some hooks are now in the agent-hooks registry
      const postToolHooks = getRegisteredHooks("PostToolUse");
      const libraryIds = postToolHooks.map((h) => h.id);
      expect(libraryIds).toContain("core-session-heartbeat");
    });

    it("skips hooks already registered", () => {
      // Register a hook manually first
      registerHook("PostToolUse", {
        id: "core-session-heartbeat",
        command: "echo test",
        timeout: 5000,
        blocking: false,
        sdks: ["*"],
      });

      initializeHookState(testDir);
      const byEvent = getHooksForRegistration(testDir);
      const result = registerLibraryHooks(byEvent);
      expect(result.skipped).toBeGreaterThan(0);
    });

    it("handles null input gracefully", () => {
      const result = registerLibraryHooks(null);
      expect(result.registered).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  // ── Library Integration ───────────────────────────────────────────────────

  describe("getHooksAsLibraryEntries()", () => {
    it("converts hooks to library entry format", () => {
      const entries = getHooksAsLibraryEntries();
      expect(entries.length).toBe(BUILTIN_HOOKS.length);
      for (const entry of entries) {
        expect(entry.type).toBe("hook");
        expect(entry.id).toMatch(/^hook-/);
        expect(entry.filename).toMatch(/\.json$/);
        expect(Array.isArray(entry.tags)).toBe(true);
        expect(entry.meta).toHaveProperty("category");
        expect(entry.meta).toHaveProperty("events");
        expect(entry.meta).toHaveProperty("compatibility");
      }
    });
  });

  describe("syncHooksToLibrary()", () => {
    it("returns hook entries when library functions not provided", () => {
      const result = syncHooksToLibrary(testDir);
      expect(result.total).toBe(BUILTIN_HOOKS.length);
      expect(result.entries.length).toBe(BUILTIN_HOOKS.length);
    });

    it("calls upsert for each hook when functions provided", () => {
      let upsertCount = 0;
      const mockFns = {
        upsertEntry: () => { upsertCount++; },
        getEntry: () => null,
      };
      const result = syncHooksToLibrary(testDir, mockFns);
      expect(result.total).toBe(BUILTIN_HOOKS.length);
      expect(upsertCount).toBe(BUILTIN_HOOKS.length);
    });
  });

  // ── Hook Definition Integrity ─────────────────────────────────────────────

  describe("hook definitions integrity", () => {
    it("all hooks have unique IDs", () => {
      const ids = BUILTIN_HOOKS.map((h) => h.id);
      expect(ids.length).toBe(new Set(ids).size);
    });

    it("all hooks reference valid categories", () => {
      const validCategories = HOOK_CATEGORIES.map((c) => c.id);
      for (const hook of BUILTIN_HOOKS) {
        expect(validCategories).toContain(hook.category);
      }
    });

    it("all hooks reference valid events", () => {
      for (const hook of BUILTIN_HOOKS) {
        const events = Array.isArray(hook.events) ? hook.events : [hook.events];
        for (const event of events) {
          expect(HOOK_EVENTS).toContain(event);
        }
      }
    });

    it("all core hooks have disableWarning", () => {
      for (const hook of BUILTIN_HOOKS) {
        if (hook.core) {
          expect(hook.disableWarning).toBeTruthy();
        }
      }
    });

    it("all core hooks are default-enabled", () => {
      for (const hook of BUILTIN_HOOKS) {
        if (hook.core) {
          expect(hook.defaultEnabled).toBe(true);
        }
      }
    });

    it("all hooks have non-empty command", () => {
      for (const hook of BUILTIN_HOOKS) {
        expect(hook.command.length).toBeGreaterThan(0);
      }
    });

    it("powershell file writers force UTF-8 encoding", () => {
      for (const hook of BUILTIN_HOOKS) {
        if (!hook.command.includes("powershell -NoProfile -Command")) continue;
        const writes = hook.command.match(/\b(?:Set-Content|Add-Content)\b/g) || [];
        if (!writes.length) continue;
        expect(hook.command).not.toMatch(/\b(?:Set-Content|Add-Content)\b(?!\s+-Encoding UTF8)/);
      }
    });

    it("all hooks have positive timeout", () => {
      for (const hook of BUILTIN_HOOKS) {
        expect(hook.timeout).toBeGreaterThan(0);
      }
    });

    it("blocking hooks are explicitly marked", () => {
      for (const hook of BUILTIN_HOOKS) {
        expect(typeof hook.blocking).toBe("boolean");
      }
    });

    it("all hooks have tags array", () => {
      for (const hook of BUILTIN_HOOKS) {
        expect(Array.isArray(hook.tags)).toBe(true);
        expect(hook.tags.length).toBeGreaterThan(0);
      }
    });
  });
});
