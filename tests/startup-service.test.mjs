import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";

// Mock child_process and fs before importing the module
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("startup-service", () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    // Dynamic import to pick up fresh mocks each time
    mod = await import("../startup-service.mjs");
  });

  describe("getStartupStatus", () => {
    it("returns an object with installed property", () => {
      const status = mod.getStartupStatus();
      expect(status).toHaveProperty("installed");
      expect(status).toHaveProperty("method");
    });

    it("returns installed: false when no service is registered", () => {
      // execSync throws = not found
      execSync.mockImplementation(() => {
        throw new Error("not found");
      });
      existsSync.mockReturnValue(false);

      const status = mod.getStartupStatus();
      expect(status.installed).toBe(false);
    });
  });

  describe("getStartupMethodName", () => {
    it("returns a non-empty string", () => {
      const name = mod.getStartupMethodName();
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    });

    it("returns platform-appropriate method name", () => {
      const name = mod.getStartupMethodName();
      const validNames = [
        "Windows Task Scheduler",
        "macOS launchd",
        "systemd user service",
        "unsupported",
      ];
      expect(validNames).toContain(name);
    });
  });

  describe("installStartupService", () => {
    it("returns a result object with success field", async () => {
      // Mock execSync for schtasks/launchctl/systemctl behaviors
      execSync.mockImplementation(() => "");
      existsSync.mockReturnValue(false);
      mkdirSync.mockImplementation(() => {});
      writeFileSync.mockImplementation(() => {});

      const result = await mod.installStartupService({ daemon: true });
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("method");
    });

    it("returns success: true on successful install", async () => {
      execSync.mockImplementation(() => "");
      existsSync.mockReturnValue(false);

      const result = await mod.installStartupService({ daemon: true });
      expect(result.success).toBe(true);
    });

    it("handles install failure gracefully", async () => {
      execSync.mockImplementation(() => {
        throw new Error("permission denied");
      });
      existsSync.mockReturnValue(false);

      const result = await mod.installStartupService();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("removeStartupService", () => {
    it("returns a result object with success field", async () => {
      execSync.mockImplementation(() => "");
      existsSync.mockReturnValue(false);

      const result = await mod.removeStartupService();
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("method");
    });

    it("handles remove when no service exists gracefully", async () => {
      execSync.mockImplementation(() => {
        throw new Error("not found");
      });
      existsSync.mockReturnValue(false);

      const result = await mod.removeStartupService();
      // On some platforms remove returns success:false when nothing to remove, that's fine
      expect(result).toHaveProperty("success");
    });
  });
});
