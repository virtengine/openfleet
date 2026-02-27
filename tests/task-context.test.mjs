import { describe, expect, it } from "vitest";
import {
  parseScopedMode,
  isEnvFlagEnabled,
  resolveBosunTaskId,
  isBosunManagedSession,
  hasBosunTaskContext,
  shouldAddBosunCoAuthor,
  shouldAutoInstallGitHooks,
  shouldRunAgentHookBridge,
} from "../task-context.mjs";

describe("task-context", () => {
  describe("parseScopedMode", () => {
    it("normalizes task-scoped aliases", () => {
      expect(parseScopedMode("task")).toBe("task");
      expect(parseScopedMode("task-only")).toBe("task");
      expect(parseScopedMode("scoped")).toBe("task");
    });

    it("normalizes always/off aliases", () => {
      expect(parseScopedMode("always")).toBe("always");
      expect(parseScopedMode("global")).toBe("always");
      expect(parseScopedMode("off")).toBe("off");
      expect(parseScopedMode("disabled")).toBe("off");
    });

    it("falls back to task mode for unknown values", () => {
      expect(parseScopedMode("unknown")).toBe("task");
    });
  });

  describe("task context detection", () => {
    it("reads task id aliases", () => {
      expect(resolveBosunTaskId({ VE_TASK_ID: "ve-1" })).toBe("ve-1");
      expect(resolveBosunTaskId({ BOSUN_TASK_ID: "bs-1" })).toBe("bs-1");
      expect(resolveBosunTaskId({ VK_TASK_ID: "vk-1" })).toBe("vk-1");
      expect(resolveBosunTaskId({})).toBe("");
    });

    it("requires managed marker for active task context", () => {
      expect(
        hasBosunTaskContext({
          VE_TASK_ID: "task-1",
          VE_MANAGED: "1",
        }),
      ).toBe(true);
      expect(
        hasBosunTaskContext({
          BOSUN_TASK_ID: "task-1",
          BOSUN_MANAGED: "true",
        }),
      ).toBe(true);
      expect(
        hasBosunTaskContext({
          VE_TASK_ID: "task-1",
          VE_MANAGED: "0",
        }),
      ).toBe(false);
      expect(
        hasBosunTaskContext({
          VE_MANAGED: "1",
        }),
      ).toBe(false);
    });

    it("parses env-style booleans", () => {
      expect(isEnvFlagEnabled("true")).toBe(true);
      expect(isEnvFlagEnabled("1")).toBe(true);
      expect(isEnvFlagEnabled("off")).toBe(false);
      expect(isEnvFlagEnabled("0")).toBe(false);
      expect(isEnvFlagEnabled("unknown", true)).toBe(true);
    });

    it("detects managed sessions", () => {
      expect(isBosunManagedSession({ VE_MANAGED: "1" })).toBe(true);
      expect(isBosunManagedSession({ BOSUN_MANAGED: "true" })).toBe(true);
      expect(isBosunManagedSession({ VE_MANAGED: "0" })).toBe(false);
    });
  });

  describe("scoped behavior gates", () => {
    it("uses task scope by default for co-author attribution", () => {
      expect(shouldAddBosunCoAuthor({ env: {} })).toBe(false);
      expect(
        shouldAddBosunCoAuthor({
          env: { VE_TASK_ID: "task-1", VE_MANAGED: "1" },
        }),
      ).toBe(true);
    });

    it("supports co-author mode overrides", () => {
      expect(
        shouldAddBosunCoAuthor({
          env: { BOSUN_COAUTHOR_MODE: "always" },
        }),
      ).toBe(true);
      expect(
        shouldAddBosunCoAuthor({
          env: { BOSUN_COAUTHOR_MODE: "off" },
        }),
      ).toBe(false);
    });

    it("supports auto-hook install mode overrides", () => {
      expect(shouldAutoInstallGitHooks({ env: {} })).toBe(false);
      expect(
        shouldAutoInstallGitHooks({
          env: { VE_TASK_ID: "task-2", VE_MANAGED: "1" },
        }),
      ).toBe(true);
      expect(
        shouldAutoInstallGitHooks({
          env: { BOSUN_AUTO_GIT_HOOKS_MODE: "always" },
        }),
      ).toBe(true);
      expect(
        shouldAutoInstallGitHooks({
          env: { BOSUN_AUTO_GIT_HOOKS_MODE: "off" },
        }),
      ).toBe(false);
    });

    it("runs agent hook bridge only for active task context unless forced", () => {
      expect(shouldRunAgentHookBridge({})).toBe(false);
      expect(
        shouldRunAgentHookBridge({
          VE_TASK_ID: "task-3",
          VE_MANAGED: "1",
        }),
      ).toBe(true);
      expect(
        shouldRunAgentHookBridge({
          BOSUN_HOOKS_FORCE: "1",
        }),
      ).toBe(true);
    });
  });
});

