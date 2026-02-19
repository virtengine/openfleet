/**
 * @module tests/agent-hooks.test.mjs
 * @description Unit tests for the agent-hooks lifecycle system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOOK_EVENTS,
  TAG,
  registerHook,
  unregisterHook,
  getRegisteredHooks,
  executeHooks,
  executeBlockingHooks,
  registerBuiltinHooks,
  loadHooks,
  resetHooks,
} from "../agent-hooks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "..", ".cache", "test-hooks");
const HOOK_ENV_VARS = [
  "OPENFLEET_HOOKS_BUILTINS_MODE",
  "OPENFLEET_HOOKS_DISABLE_PREPUSH",
  "OPENFLEET_HOOKS_DISABLE_TASK_COMPLETE",
  "OPENFLEET_HOOKS_DISABLE_VALIDATION",
  "VE_HOOK_DISABLE_PREPUSH",
  "VE_HOOK_DISABLE_TASK_COMPLETE",
];

describe("agent-hooks", () => {
  beforeEach(() => {
    resetHooks();
    mkdirSync(fixtureDir, { recursive: true });
    for (const name of HOOK_ENV_VARS) delete process.env[name];
  });

  afterEach(() => {
    resetHooks();
    for (const name of HOOK_ENV_VARS) delete process.env[name];
    try {
      for (const f of ["hooks.json", "bad.json"]) {
        const p = resolve(fixtureDir, f);
        if (existsSync(p)) unlinkSync(p);
      }
    } catch {
      /* best effort */
    }
  });

  describe("HOOK_EVENTS", () => {
    it("should export the correct list of hook events", () => {
      expect(HOOK_EVENTS).toBeDefined();
      expect(Array.isArray(HOOK_EVENTS)).toBe(true);
      expect(HOOK_EVENTS).toContain("SessionStart");
      expect(HOOK_EVENTS).toContain("SessionStop");
      expect(HOOK_EVENTS).toContain("PrePush");
      expect(HOOK_EVENTS).toContain("PostPush");
      expect(HOOK_EVENTS).toContain("PreCommit");
      expect(HOOK_EVENTS).toContain("PostCommit");
      expect(HOOK_EVENTS).toContain("PrePR");
      expect(HOOK_EVENTS).toContain("PostPR");
      expect(HOOK_EVENTS).toContain("TaskComplete");
      expect(HOOK_EVENTS).toContain("PreToolUse");
      expect(HOOK_EVENTS).toContain("PostToolUse");
      expect(HOOK_EVENTS).toContain("SubagentStart");
      expect(HOOK_EVENTS).toContain("SubagentStop");
      expect(HOOK_EVENTS.length).toBe(13);
    });

    it("should be frozen", () => {
      expect(Object.isFrozen(HOOK_EVENTS)).toBe(true);
    });
  });

  describe("TAG", () => {
    it("should export a TAG constant", () => {
      expect(TAG).toBe("[agent-hooks]");
    });
  });

  describe("registerHook", () => {
    it("should register a hook and return its ID", () => {
      const id = registerHook("PrePush", {
        id: "test-prepush-1",
        command: "echo test",
        blocking: true,
      });
      expect(id).toBe("test-prepush-1");
    });

    it("should auto-generate an ID if not provided", () => {
      const id = registerHook("SessionStart", {
        command: "echo auto-id",
      });
      expect(typeof id).toBe("string");
      expect(id.startsWith("hook-")).toBe(true);
    });

    it("should throw on invalid event name", () => {
      expect(() =>
        registerHook("InvalidEvent", { command: "echo nope" }),
      ).toThrow("invalid hook event");
    });

    it("should deduplicate by ID (update instead of add)", () => {
      registerHook("PrePush", {
        id: "dedup-test",
        command: "echo v1",
        blocking: false,
      });
      registerHook("PrePush", {
        id: "dedup-test",
        command: "echo v2",
        blocking: true,
      });

      const hooks = getRegisteredHooks("PrePush");
      const dedup = hooks.filter((h) => h.id === "dedup-test");
      expect(dedup.length).toBe(1);
      expect(dedup[0].command).toBe("echo v2");
      expect(dedup[0].blocking).toBe(true);
    });

    it("should normalize SDK wildcards", () => {
      registerHook("SessionStart", {
        id: "sdk-wildcard",
        command: "echo test",
        sdks: ["*", "codex"],
      });
      const hooks = getRegisteredHooks("SessionStart");
      const found = hooks.find((h) => h.id === "sdk-wildcard");
      expect(found.sdks).toEqual(["*"]);
    });
  });

  describe("unregisterHook", () => {
    it("should remove a registered hook", () => {
      registerHook("PrePush", {
        id: "remove-me",
        command: "echo bye",
      });
      const removed = unregisterHook("PrePush", "remove-me");
      expect(removed).toBe(true);

      const hooks = getRegisteredHooks("PrePush");
      expect(hooks.find((h) => h.id === "remove-me")).toBeUndefined();
    });

    it("should return false for non-existent hook", () => {
      const removed = unregisterHook("PrePush", "does-not-exist");
      expect(removed).toBe(false);
    });
  });

  describe("getRegisteredHooks", () => {
    it("should return hooks for a specific event", () => {
      registerHook("PostPush", { id: "pp-1", command: "echo 1" });
      registerHook("PostPush", { id: "pp-2", command: "echo 2" });

      const hooks = getRegisteredHooks("PostPush");
      expect(hooks.length).toBe(2);
      expect(hooks[0].id).toBe("pp-1");
      expect(hooks[1].id).toBe("pp-2");
    });

    it("should return all hooks when no event specified", () => {
      registerHook("SessionStart", { id: "ss-1", command: "echo a" });
      registerHook("PrePush", { id: "push-1", command: "echo b" });

      const all = getRegisteredHooks();
      expect(typeof all).toBe("object");
      expect(all.SessionStart?.length).toBeGreaterThanOrEqual(1);
      expect(all.PrePush?.length).toBeGreaterThanOrEqual(1);
    });

    it("should throw on invalid event", () => {
      expect(() => getRegisteredHooks("bogus")).toThrow("invalid hook event");
    });
  });

  describe("executeHooks", () => {
    it("should execute a non-blocking hook successfully", async () => {
      registerHook("SessionStart", {
        id: "exec-test",
        command: "echo hello-hooks",
        blocking: false,
        timeout: 10000,
      });

      const results = await executeHooks("SessionStart", {
        taskId: "test-123",
        sdk: "codex",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const r = results.find((r) => r.id === "exec-test");
      expect(r).toBeDefined();
      expect(r.success).toBe(true);
      expect(r.exitCode).toBe(0);
    });

    it("should filter hooks by SDK", async () => {
      registerHook("SessionStart", {
        id: "codex-only",
        command: "echo codex",
        sdks: ["codex"],
        blocking: false,
      });
      registerHook("SessionStart", {
        id: "claude-only",
        command: "echo claude",
        sdks: ["claude"],
        blocking: false,
      });

      const results = await executeHooks("SessionStart", {
        sdk: "codex",
      });

      const ids = results.map((r) => r.id);
      expect(ids).toContain("codex-only");
      expect(ids).not.toContain("claude-only");
    });

    it("should return empty array for unknown event", async () => {
      const results = await executeHooks("UnknownEvent", {});
      expect(results).toEqual([]);
    });

    it("should handle failing non-blocking hooks gracefully", async () => {
      registerHook("PostPush", {
        id: "fail-nonblock",
        command: "exit 1",
        blocking: false,
        timeout: 10000,
      });

      const results = await executeHooks("PostPush", {});
      const r = results.find((r) => r.id === "fail-nonblock");
      expect(r).toBeDefined();
      expect(r.success).toBe(false);
    });
  });

  describe("executeBlockingHooks", () => {
    it("should pass when all blocking hooks succeed", async () => {
      registerHook("PrePush", {
        id: "block-pass-1",
        command: "echo passing",
        blocking: true,
        timeout: 10000,
      });
      registerHook("PrePush", {
        id: "block-pass-2",
        command: "echo also-passing",
        blocking: true,
        timeout: 10000,
      });

      const result = await executeBlockingHooks("PrePush", {
        sdk: "copilot",
      });
      expect(result.passed).toBe(true);
      expect(result.failures.length).toBe(0);
      expect(result.results.length).toBe(2);
    });

    it("should fail when a blocking hook returns non-zero", async () => {
      registerHook("PreCommit", {
        id: "block-fail",
        command: "exit 42",
        blocking: true,
        timeout: 10000,
      });

      const result = await executeBlockingHooks("PreCommit", {
        sdk: "claude",
      });
      expect(result.passed).toBe(false);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].exitCode).toBe(42);
    });

    it("should skip non-blocking hooks", async () => {
      registerHook("PrePR", {
        id: "non-block-skip",
        command: "exit 1",
        blocking: false,
        timeout: 10000,
      });

      const result = await executeBlockingHooks("PrePR", {});
      expect(result.passed).toBe(true);
      expect(result.results.length).toBe(0);
    });

    it("should return passed for unknown events", async () => {
      const result = await executeBlockingHooks("NoSuchEvent", {});
      expect(result.passed).toBe(true);
    });
  });

  describe("registerBuiltinHooks", () => {
    it("should register built-in PrePush and TaskComplete hooks", () => {
      registerBuiltinHooks();

      const prePush = getRegisteredHooks("PrePush");
      const taskComplete = getRegisteredHooks("TaskComplete");

      expect(
        prePush.find((h) => h.id === "builtin-prepush-preflight"),
      ).toBeDefined();
      expect(
        taskComplete.find((h) => h.id === "builtin-task-complete-validation"),
      ).toBeDefined();
    });

    it("should register builtins with blocking=true", () => {
      registerBuiltinHooks();

      const prePush = getRegisteredHooks("PrePush");
      const builtin = prePush.find((h) => h.id === "builtin-prepush-preflight");
      expect(builtin.blocking).toBe(true);
      expect(builtin.builtin).toBe(true);
    });

    it("should be idempotent (no duplicates on re-call)", () => {
      registerBuiltinHooks();
      registerBuiltinHooks();

      const prePush = getRegisteredHooks("PrePush");
      const count = prePush.filter(
        (h) => h.id === "builtin-prepush-preflight",
      ).length;
      expect(count).toBe(1);
    });

    it("should skip builtins when mode=off", () => {
      process.env.OPENFLEET_HOOKS_BUILTINS_MODE = "off";
      registerBuiltinHooks();

      expect(getRegisteredHooks("PrePush")).toEqual([]);
      expect(getRegisteredHooks("TaskComplete")).toEqual([]);
    });

    it("should auto-skip prepush builtin when custom prepush exists", () => {
      process.env.OPENFLEET_HOOKS_BUILTINS_MODE = "auto";
      registerHook("PrePush", {
        id: "custom-prepush",
        command: "echo custom",
        blocking: true,
      });
      registerBuiltinHooks();

      const prePush = getRegisteredHooks("PrePush");
      expect(prePush.find((h) => h.id === "custom-prepush")).toBeDefined();
      expect(
        prePush.find((h) => h.id === "builtin-prepush-preflight"),
      ).toBeUndefined();
    });

    it("should force builtins when mode=force even with custom hooks", () => {
      process.env.OPENFLEET_HOOKS_BUILTINS_MODE = "force";
      registerHook("PrePush", {
        id: "custom-prepush",
        command: "echo custom",
        blocking: true,
      });
      registerBuiltinHooks();

      const prePush = getRegisteredHooks("PrePush");
      expect(
        prePush.find((h) => h.id === "builtin-prepush-preflight"),
      ).toBeDefined();
    });
  });

  describe("loadHooks", () => {
    it("should load hooks from a config file", () => {
      const configPath = resolve(fixtureDir, "hooks.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                id: "from-file-1",
                command: "echo from-file",
                blocking: false,
              },
            ],
            PrePush: [
              {
                id: "from-file-push",
                command: "echo push-check",
                blocking: true,
                sdks: ["codex"],
              },
            ],
          },
        }),
      );

      const count = loadHooks(configPath);
      expect(count).toBe(2);

      const ss = getRegisteredHooks("SessionStart");
      expect(ss.find((h) => h.id === "from-file-1")).toBeDefined();

      const pp = getRegisteredHooks("PrePush");
      const push = pp.find((h) => h.id === "from-file-push");
      expect(push).toBeDefined();
      expect(push.blocking).toBe(true);
      expect(push.sdks).toEqual(["codex"]);
    });

    it("should return 0 for missing config file", () => {
      const count = loadHooks("/nonexistent/path.json");
      expect(count).toBe(0);
    });

    it("should return 0 for invalid JSON", () => {
      const badPath = resolve(fixtureDir, "bad.json");
      writeFileSync(badPath, "not json {{{");
      const count = loadHooks(badPath);
      expect(count).toBe(0);
    });

    it("should support 'agentHooks' key as alternative", () => {
      const configPath = resolve(fixtureDir, "hooks.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          agentHooks: {
            PostPR: [{ id: "alt-key", command: "echo alt" }],
          },
        }),
      );

      const count = loadHooks(configPath);
      expect(count).toBe(1);
    });

    it("should ignore unknown event names in config", () => {
      const configPath = resolve(fixtureDir, "hooks.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          hooks: {
            FakeEvent: [{ id: "fake", command: "echo fake" }],
            PrePush: [{ id: "real", command: "echo real" }],
          },
        }),
      );

      const count = loadHooks(configPath);
      expect(count).toBe(1);
    });
  });

  describe("environment variables", () => {
    it("should pass VE_ env vars to hook processes", async () => {
      const isWin = process.platform === "win32";
      const command = isWin
        ? 'powershell -NoProfile -Command "Write-Host $env:VE_TASK_ID"'
        : "echo $VE_TASK_ID";

      registerHook("PostCommit", {
        id: "env-check",
        command,
        blocking: true,
        timeout: 10000,
      });

      const results = await executeHooks("PostCommit", {
        taskId: "env-test-456",
        sdk: "codex",
      });

      const r = results.find((r) => r.id === "env-check");
      expect(r).toBeDefined();
      expect(r.success).toBe(true);
      expect(r.stdout.trim()).toBe("env-test-456");
    });
  });

  describe("resetHooks", () => {
    it("should clear all registered hooks", () => {
      registerHook("PrePush", { id: "will-reset", command: "echo x" });
      registerHook("SessionStart", { id: "also-reset", command: "echo y" });

      resetHooks();

      const pp = getRegisteredHooks("PrePush");
      const ss = getRegisteredHooks("SessionStart");
      expect(pp.length).toBe(0);
      expect(ss.length).toBe(0);
    });
  });
});
