import { describe, it, expect, vi } from "vitest";

/**
 * Tests for container-runner.mjs
 *
 * Note: ESM modules are cached — env vars are read at module load time.
 * These tests run with default state (CONTAINER_ENABLED not set → disabled).
 */

describe("container-runner", () => {
  describe("module exports", () => {
    it("exports all expected functions", async () => {
      const mod = await import("../container-runner.mjs");
      const expected = [
        "isContainerEnabled",
        "getContainerStatus",
        "checkContainerRuntime",
        "ensureContainerRuntime",
        "runInContainer",
        "stopAllContainers",
        "cleanupOrphanedContainers",
      ];
      for (const name of expected) {
        expect(typeof mod[name]).toBe("function");
      }
    });
  });

  describe("isContainerEnabled (default disabled)", () => {
    it("returns false when CONTAINER_ENABLED is not set", async () => {
      const mod = await import("../container-runner.mjs");
      expect(mod.isContainerEnabled()).toBe(false);
    });
  });

  describe("getContainerStatus", () => {
    it("returns status object with expected structure", async () => {
      const mod = await import("../container-runner.mjs");
      const status = mod.getContainerStatus();
      expect(status).toBeDefined();
      expect(typeof status.enabled).toBe("boolean");
      expect(status.enabled).toBe(false); // default not enabled
    });

    it("has runtime property", async () => {
      const mod = await import("../container-runner.mjs");
      const status = mod.getContainerStatus();
      expect("runtime" in status).toBe(true);
    });

    it("has active property", async () => {
      const mod = await import("../container-runner.mjs");
      const status = mod.getContainerStatus();
      expect(typeof status.active).toBe("number");
      expect(status.active).toBe(0);
    });

    it("has maxConcurrent property", async () => {
      const mod = await import("../container-runner.mjs");
      const status = mod.getContainerStatus();
      expect("maxConcurrent" in status).toBe(true);
      expect(typeof status.maxConcurrent).toBe("number");
    });

    it("has containers array", async () => {
      const mod = await import("../container-runner.mjs");
      const status = mod.getContainerStatus();
      expect(Array.isArray(status.containers)).toBe(true);
      expect(status.containers).toHaveLength(0);
    });
  });

  describe("checkContainerRuntime", () => {
    it("returns an object with available field", async () => {
      const mod = await import("../container-runner.mjs");
      const result = mod.checkContainerRuntime();
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
      expect("available" in result).toBe(true);
      expect(typeof result.available).toBe("boolean");
    });

    it("returns runtime in result", async () => {
      const mod = await import("../container-runner.mjs");
      const result = mod.checkContainerRuntime();
      expect("runtime" in result).toBe(true);
    });

    it("returns platform in result", async () => {
      const mod = await import("../container-runner.mjs");
      const result = mod.checkContainerRuntime();
      expect("platform" in result).toBe(true);
      expect(result.platform).toBe(process.platform);
    });
  });

  describe("stopAllContainers", () => {
    it("resolves when no containers are running", async () => {
      const mod = await import("../container-runner.mjs");
      // stopAllContainers should be safe to call at any time
      const result = mod.stopAllContainers();
      if (result instanceof Promise) {
        await expect(result).resolves.not.toThrow();
      }
      // If it's sync, the fact we didn't throw is sufficient
    });
  });

  describe("cleanupOrphanedContainers", () => {
    it("does not throw when no containers exist", async () => {
      const mod = await import("../container-runner.mjs");
      // cleanupOrphanedContainers is synchronous and catches errors internally
      expect(() => mod.cleanupOrphanedContainers()).not.toThrow();
    });
  });

  describe("runInContainer", () => {
    it("rejects when container is disabled", async () => {
      const mod = await import("../container-runner.mjs");
      // Should reject since containers are not enabled
      await expect(
        mod.runInContainer({
          command: "echo hello",
          workDir: "/tmp",
        }),
      ).rejects.toThrow();
    });
  });

  describe("source code structure", () => {
    it("defines sentinel markers for output parsing", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "container-runner.mjs"),
        "utf8",
      );

      expect(source).toContain("CODEXMON_OUTPUT_START");
      expect(source).toContain("CODEXMON_OUTPUT_END");
    });

    it("supports docker, podman, and apple-container runtimes", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "container-runner.mjs"),
        "utf8",
      );

      expect(source).toContain("docker");
      expect(source).toContain("podman");
      expect(source).toContain("container"); // apple-container
    });

    it("tracks active containers with Map", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "container-runner.mjs"),
        "utf8",
      );

      expect(source).toContain("activeContainers");
      expect(source).toContain("new Map()");
    });
  });
});
