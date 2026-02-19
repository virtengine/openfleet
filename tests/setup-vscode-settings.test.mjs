import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildRecommendedVsCodeSettings,
  writeWorkspaceVsCodeSettings,
} from "../setup.mjs";

describe("setup vscode settings", () => {
  it("builds recommended Copilot autonomous defaults", () => {
    const settings = buildRecommendedVsCodeSettings({
      COPILOT_AGENT_MAX_REQUESTS: "500",
    });

    expect(settings["github.copilot.chat.searchSubagent.enabled"]).toBe(true);
    expect(settings["github.copilot.chat.cli.mcp.enabled"]).toBe(true);
    expect(settings["github.copilot.chat.agent.enabled"]).toBe(true);
    expect(settings["github.copilot.chat.agent.maxRequests"]).toBe(500);
  });

  it("merges into existing workspace settings", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "openfleet-vscode-"));
    const vscodeDir = resolve(repoRoot, ".vscode");
    const settingsPath = resolve(vscodeDir, "settings.json");

    try {
      await mkdir(vscodeDir, { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          "editor.formatOnSave": true,
          "github.copilot.chat.cli.mcp.enabled": false,
        }),
        "utf8",
      );

      const result = writeWorkspaceVsCodeSettings(repoRoot, {
        COPILOT_AGENT_MAX_REQUESTS: "321",
      });
      expect(result.updated).toBe(true);

      const raw = await readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed["editor.formatOnSave"]).toBe(true);
      expect(parsed["github.copilot.chat.cli.mcp.enabled"]).toBe(true);
      expect(parsed["github.copilot.chat.agent.maxRequests"]).toBe(321);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
