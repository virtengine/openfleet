import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AGENT_PROMPT_DEFINITIONS, DEFAULT_PROMPTS } from "../agent/agent-prompt-catalog.mjs";
import { ensureAgentPromptWorkspace } from "../agent/agent-prompts.mjs";
import { lintPromptText, lintPromptWorkspace, NARRATION_PHRASES } from "../tools/prompt-lint.mjs";

let testRoot;

async function makeTempRoot() {
  const dir = await mkdtemp(resolve(tmpdir(), "prompt-lint-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("prompt lint", () => {
  beforeEach(async () => {
    testRoot = await makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("keeps every builtin prompt template narration-free", () => {
    expect(AGENT_PROMPT_DEFINITIONS.length).toBeGreaterThan(20);
    expect(NARRATION_PHRASES).toEqual(expect.arrayContaining(["Let me", "I'll"]));

    for (const definition of AGENT_PROMPT_DEFINITIONS) {
      const content = DEFAULT_PROMPTS[definition.key];
      expect(content).toBeTruthy();
      expect(lintPromptText(content, definition.filename)).toEqual([]);
    }
  });

  it("scaffolds prompt templates into .bosun/agents without lint violations", () => {
    const scaffold = ensureAgentPromptWorkspace(testRoot);
    const result = lintPromptWorkspace(testRoot);

    expect(scaffold.workspaceDir).toBe(resolve(testRoot, ".bosun", "agents"));
    expect(scaffold.written).toHaveLength(AGENT_PROMPT_DEFINITIONS.length);
    expect(result.ok).toBe(true);
    expect(result.targets).toHaveLength(AGENT_PROMPT_DEFINITIONS.length);
  });

  it("flags narration regressions inside workspace prompt files", async () => {
    const promptDir = resolve(testRoot, ".bosun", "agents");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = resolve(promptDir, "orchestrator.md");

    await writeFile(promptPath, "# Override\n\nI will use TodoWrite to narrate every step.\n", "utf8");

    const result = lintPromptWorkspace(testRoot);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".bosun/agents/orchestrator.md",
          phrase: "I will use",
        }),
      ]),
    );
  });

  it("ignores gitignored workspace prompt files in repo roots", async () => {
    execFileSync("git", ["init"], { cwd: testRoot, stdio: "ignore" });
    await writeFile(resolve(testRoot, ".gitignore"), "/.bosun/\n", "utf8");
    const promptDir = resolve(testRoot, ".bosun", "agents");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = resolve(promptDir, "ignored.md");

    await writeFile(promptPath, "# Ignored\n\nLet me narrate this local override.\n", "utf8");

    const result = lintPromptWorkspace(testRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.targets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".bosun/agents/ignored.md" }),
      ]),
    );
  });
  it("keeps CI and pre-commit prompt lint wiring enabled", () => {
    const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
    const preCommitHook = readFileSync(resolve(process.cwd(), ".githooks", "pre-commit"), "utf8");

    expect(packageJson).toContain('"pretest": "npm run syntax:check && npm run prompt:lint"');
    expect(preCommitHook).toContain("npm run prompt:lint");
  });
});
