import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  ensureAgentPromptWorkspace,
  getDefaultPromptWorkspace,
  PROMPT_WORKSPACE_DIR,
} from "../agent-prompts.mjs";

describe("agent-prompts workspace", () => {
  const envKeys = [
    "BOSUN_PROMPT_WORKSPACE",
    "BOSUN_HOME",
    "HOME",
    "USERPROFILE",
  ];
  const saved = new Map();

  for (const key of envKeys) {
    saved.set(key, process.env[key]);
  }

  afterEach(async () => {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses explicit prompt workspace override", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "prompts-root-"));
    const custom = await mkdtemp(resolve(tmpdir(), "prompts-custom-"));
    process.env.BOSUN_PROMPT_WORKSPACE = custom;

    const workspace = getDefaultPromptWorkspace(root);
    expect(workspace).toBe(custom);

    await rm(root, { recursive: true, force: true });
    await rm(custom, { recursive: true, force: true });
  });

  it("falls back to HOME when primary prompt directory cannot be created", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "prompts-bad-root-"));
    const home = await mkdtemp(resolve(tmpdir(), "prompts-home-"));

    // Make ".bosun" a file so creating ".bosun/agents" under root fails.
    await writeFile(resolve(root, ".bosun"), "blocker\n", "utf8");

    process.env.BOSUN_PROMPT_WORKSPACE = "";
    process.env.BOSUN_HOME = "";
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const result = ensureAgentPromptWorkspace(root);
    const expectedPrefix = resolve(home, PROMPT_WORKSPACE_DIR);

    expect(result.workspaceDir).toBe(expectedPrefix);
    expect(process.env.BOSUN_PROMPT_WORKSPACE).toBe(expectedPrefix);
    expect(result.written.length).toBeGreaterThan(0);

    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
});
