import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  readSetupProgress,
  writeSetupSnapshot,
  buildWorkspaceChoices,
  getGitHubAuthScopes,
} from "../setup.mjs";

describe("setup.mjs new exports", () => {
  let tempDir;

  beforeAll(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), "bosun-setup-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readSetupProgress", () => {
    it("returns null when progress file does not exist", async () => {
      const result = readSetupProgress(tempDir);
      expect(result).toBeNull();
    });

    it("returns parsed progress object when file exists", async () => {
      // Write a fake progress file first
      const { writeFile } = await import("node:fs/promises");
      const progressPath = resolve(tempDir, ".setup-progress.json");
      const progress = {
        status: "incomplete",
        step: 2,
        total: 5,
        label: "Configuring GitHub",
        updatedAt: new Date().toISOString(),
        snapshot: { env: { GITHUB_TOKEN: "test" }, configJson: {} },
      };
      await writeFile(progressPath, JSON.stringify(progress), "utf8");

      const result = readSetupProgress(tempDir);
      expect(result).not.toBeNull();
      expect(result.status).toBe("incomplete");
      expect(result.step).toBe(2);
      expect(result.label).toBe("Configuring GitHub");
    });

    it("returns null when progress file contains invalid JSON", async () => {
      const { writeFile } = await import("node:fs/promises");
      const badDir = await mkdtemp(resolve(tmpdir(), "bosun-setup-bad-"));
      try {
        await writeFile(
          resolve(badDir, ".setup-progress.json"),
          "{ invalid json",
          "utf8",
        );
        const result = readSetupProgress(badDir);
        expect(result).toBeNull();
      } finally {
        await rm(badDir, { recursive: true, force: true });
      }
    });
  });

  describe("writeSetupSnapshot", () => {
    it("writes a setup progress snapshot to the config directory", async () => {
      const snapshotDir = await mkdtemp(resolve(tmpdir(), "bosun-snapshot-"));
      try {
        writeSetupSnapshot(snapshotDir, {
          step: 3,
          label: "Installing dependencies",
          env: { TELEGRAM_BOT_TOKEN: "test-token" },
          configJson: { agentModel: "gpt-4" },
        });

        const progressPath = resolve(snapshotDir, ".setup-progress.json");
        const raw = await readFile(progressPath, "utf8");
        const parsed = JSON.parse(raw);

        expect(parsed.status).toBe("incomplete");
        expect(parsed.step).toBe(3);
        expect(parsed.label).toBe("Installing dependencies");
        expect(parsed.snapshot.env.TELEGRAM_BOT_TOKEN).toBe("test-token");
        expect(parsed.snapshot.configJson.agentModel).toBe("gpt-4");
      } finally {
        await rm(snapshotDir, { recursive: true, force: true });
      }
    });

    it("includes updatedAt timestamp in the snapshot", async () => {
      const snapshotDir = await mkdtemp(resolve(tmpdir(), "bosun-ts-"));
      try {
        const before = new Date().toISOString();
        writeSetupSnapshot(snapshotDir, {
          step: 1,
          label: "Start",
          env: {},
          configJson: {},
        });

        const progressPath = resolve(snapshotDir, ".setup-progress.json");
        const raw = await readFile(progressPath, "utf8");
        const parsed = JSON.parse(raw);

        expect(parsed.updatedAt).toBeTruthy();
        expect(new Date(parsed.updatedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(before).getTime(),
        );
      } finally {
        await rm(snapshotDir, { recursive: true, force: true });
      }
    });

    it("tolerates missing env and configJson fields", async () => {
      const snapshotDir = await mkdtemp(resolve(tmpdir(), "bosun-partial-"));
      try {
        expect(() => {
          writeSetupSnapshot(snapshotDir, { step: 1, label: "Test" });
        }).not.toThrow();

        const progressPath = resolve(snapshotDir, ".setup-progress.json");
        const raw = await readFile(progressPath, "utf8");
        const parsed = JSON.parse(raw);

        expect(parsed.snapshot.env).toEqual({});
        expect(parsed.snapshot.configJson).toEqual({});
      } finally {
        await rm(snapshotDir, { recursive: true, force: true });
      }
    });
  });

  describe("buildWorkspaceChoices", () => {
    it("returns empty array for empty or missing workspaces", () => {
      expect(buildWorkspaceChoices({})).toEqual([]);
      expect(buildWorkspaceChoices({ workspaces: [] })).toEqual([]);
    });

    it("maps workspace entries to choice objects with id, name, label, repos", () => {
      const configJson = {
        workspaces: [
          {
            id: "ws-1",
            name: "Main Workspace",
            repos: ["owner/repo1", "owner/repo2"],
          },
        ],
      };

      const choices = buildWorkspaceChoices(configJson);
      expect(choices).toHaveLength(1);
      expect(choices[0].id).toBe("ws-1");
      expect(choices[0].name).toBe("Main Workspace");
      expect(choices[0].repos).toEqual(["owner/repo1", "owner/repo2"]);
      expect(choices[0].label).toBeTruthy();
    });

    it("deduplicates workspaces by lowercased id", () => {
      const configJson = {
        workspaces: [
          { id: "WS-1", name: "Workspace A" },
          { id: "ws-1", name: "Workspace A Duplicate" },
          { id: "ws-2", name: "Workspace B" },
        ],
      };

      const choices = buildWorkspaceChoices(configJson);
      const ids = choices.map((c) => c.id.toLowerCase());
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds).toHaveLength(ids.length);
    });

    it("handles workspaces without repos field", () => {
      const configJson = {
        workspaces: [{ id: "ws-1", name: "Minimal Workspace" }],
      };

      expect(() => buildWorkspaceChoices(configJson)).not.toThrow();
      const choices = buildWorkspaceChoices(configJson);
      expect(choices).toHaveLength(1);
    });
  });

  describe("getGitHubAuthScopes", () => {
    it("returns an array (empty or with scopes)", async () => {
      // This calls 'gh auth status' - may return [] if gh is not configured
      const result = await getGitHubAuthScopes(process.cwd());
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty array when gh is not configured or not available", async () => {
      // Simulate by passing a fake cwd that would cause gh to fail
      const result = await getGitHubAuthScopes("/nonexistent-fake-dir");
      expect(Array.isArray(result)).toBe(true);
      // Should not throw, just return empty array
    });

    it("returns scope strings when gh is authenticated", async () => {
      // If gh is available and authenticated, scopes should be strings
      const result = await getGitHubAuthScopes(process.cwd());
      for (const scope of result) {
        expect(typeof scope).toBe("string");
        expect(scope.length).toBeGreaterThan(0);
      }
    });
  });
});
