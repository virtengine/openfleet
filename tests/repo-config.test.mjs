import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRepoClaudeSettings,
  ensureRepoConfigs,
} from "../config/repo-config.mjs";

describe("repo-config Claude settings", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(resolve(tmpdir(), "bosun-repo-config-"));
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("builds Claude settings with Bosun-safe permissions and bridge path", () => {
    const settings = buildRepoClaudeSettings({ repoRoot: rootDir });

    expect(settings.permissions.allow).toContain("Computer:*");
    expect(settings.permissions.allow).not.toContain("computer:*");
    expect(settings.permissions.allow).not.toContain("go *");
    expect(settings.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toContain(
      "node agent/agent-hook-bridge.mjs --agent claude --event PreToolUse",
    );
  });

  it("repairs legacy invalid permissions and stale bridge paths when merging", async () => {
    const settingsPath = resolve(rootDir, ".claude", "settings.local.json");
    await mkdir(resolve(rootDir, ".claude"), { recursive: true });
    await writeFile(resolve(rootDir, ".claude", ".gitkeep"), "", "utf8");
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          permissions: {
            allow: ["Bash(ls:*)", "computer:*", "go *"],
            deny: [],
          },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: String.raw`node C:\repo\config\agent-hook-bridge.mjs --agent claude --event PreToolUse`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = ensureRepoConfigs(rootDir);
    const merged = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(result.claudeSettings.updated).toBe(true);
    expect(merged.permissions.allow).toContain("Bash(ls:*)");
    expect(merged.permissions.allow).toContain("Computer:*");
    expect(merged.permissions.allow).not.toContain("computer:*");
    expect(merged.permissions.allow).not.toContain("go *");
    expect(merged.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toContain(
      "node agent/agent-hook-bridge.mjs --agent claude --event PreToolUse",
    );
    expect(merged.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).not.toContain(
      String.raw`config\agent-hook-bridge.mjs`,
    );
  });
});