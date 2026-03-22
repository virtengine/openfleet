import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateRepoMap } from "../agent/repo-map.mjs";

describe("repo-map", () => {
  it("builds a compact structural summary", () => {
    const root = mkdtempSync(join(tmpdir(), "bosun-repo-map-"));
    try {
      mkdirSync(join(root, "agent"));
      mkdirSync(join(root, "shell"));
      writeFileSync(join(root, "package.json"), '{"name":"demo"}');
      writeFileSync(join(root, "agent", "primary-agent.mjs"), 'import x from "y";\nexport async function execPrimaryPrompt() {}\nexport const VALUE = 1;');
      writeFileSync(join(root, "shell", "codex-shell.mjs"), 'import z from "q";\nexport function buildCodexPromptEnvelope() {}');

      const map = generateRepoMap(root, { maxFiles: 5, maxSummaryLines: 5 });
      expect(map).toContain("Root:");
      expect(map).toContain("Hotspots:");
      expect(map).toContain("agent/primary-agent.mjs");
      expect(map).toContain("shell/codex-shell.mjs");
      expect(map).toContain("export async function execPrimaryPrompt()");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
