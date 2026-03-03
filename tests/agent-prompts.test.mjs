import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  applyPromptDefaultUpdates,
  ensureAgentPromptWorkspace,
  getDefaultPromptTemplate,
  getPromptDefaultUpdateStatus,
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
  const tempDirs = [];

  for (const key of envKeys) {
    saved.set(key, process.env[key]);
  }

  const sha256 = (value) =>
    createHash("sha256").update(String(value), "utf8").digest("hex");

  const createTempDir = async (prefix) => {
    const dir = await mkdtemp(resolve(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses explicit prompt workspace override", async () => {
    const root = await createTempDir("prompts-root-");
    const custom = await createTempDir("prompts-custom-");
    process.env.BOSUN_PROMPT_WORKSPACE = custom;

    const workspace = getDefaultPromptWorkspace(root);
    expect(workspace).toBe(custom);
  });

  it("falls back to HOME when primary prompt directory cannot be created", async () => {
    const root = await createTempDir("prompts-bad-root-");
    const home = await createTempDir("prompts-home-");

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
  });

  it("creates files with metadata hash in ensureAgentPromptWorkspace", async () => {
    const root = await createTempDir("prompts-metadata-root-");
    const workspace = await createTempDir("prompts-metadata-workspace-");
    process.env.BOSUN_PROMPT_WORKSPACE = workspace;

    const result = ensureAgentPromptWorkspace(root);
    expect(result.written.length).toBeGreaterThan(0);

    const filePath = resolve(workspace, "orchestrator.md");
    const content = await readFile(filePath, "utf8");
    const expectedHash = sha256(getDefaultPromptTemplate("orchestrator").trimEnd());

    expect(content).toContain("<!-- bosun prompt: orchestrator -->");
    expect(content).toContain("<!-- bosun description:");
    expect(content).toContain(`<!-- bosun default-sha256: ${expectedHash} -->`);
  });

  it("detects missing files as updateAvailable", async () => {
    const root = await createTempDir("prompts-missing-root-");
    const workspace = await createTempDir("prompts-missing-workspace-");
    process.env.BOSUN_PROMPT_WORKSPACE = workspace;

    const status = getPromptDefaultUpdateStatus(root);

    expect(status.summary.total).toBeGreaterThan(0);
    expect(status.summary.missing).toBe(status.summary.total);
    expect(status.summary.updateAvailable).toBe(status.summary.total);
    expect(status.summary.needsReview).toBe(0);

    const orchestrator = status.updates.find((item) => item.key === "orchestrator");
    expect(orchestrator?.exists).toBe(false);
    expect(orchestrator?.updateAvailable).toBe(true);
    expect(orchestrator?.reason).toBe("missing");
  });

  it("detects user-modified file as needsReview and not updateAvailable", async () => {
    const root = await createTempDir("prompts-needs-review-root-");
    const workspace = await createTempDir("prompts-needs-review-workspace-");
    process.env.BOSUN_PROMPT_WORKSPACE = workspace;

    const key = "taskExecutor";
    const filename = "task-executor.md";
    const basePrompt = `${getDefaultPromptTemplate(key)}\nLEGACY DEFAULT`;
    const recordedHash = sha256(basePrompt.trimEnd());
    const userModified = `${basePrompt}\nUSER MODIFICATION`;
    const body = [
      `<!-- bosun prompt: ${key} -->`,
      `<!-- bosun description: test -->`,
      `<!-- bosun default-sha256: ${recordedHash} -->`,
      "",
      userModified,
      "",
    ].join("\n");

    await writeFile(resolve(workspace, filename), body, "utf8");

    const status = getPromptDefaultUpdateStatus(root);
    const entry = status.updates.find((item) => item.key === key);

    expect(entry?.exists).toBe(true);
    expect(entry?.updateAvailable).toBe(false);
    expect(entry?.needsReview).toBe(true);
    expect(entry?.reason).toBe("modified");
  });

  it("applyPromptDefaultUpdates updates missing and outdated-unmodified files and skips needsReview", async () => {
    const root = await createTempDir("prompts-apply-root-");
    const workspace = await createTempDir("prompts-apply-workspace-");
    process.env.BOSUN_PROMPT_WORKSPACE = workspace;

    const outdatedKey = "orchestrator";
    const outdatedFilename = "orchestrator.md";
    const outdatedPrompt = `${getDefaultPromptTemplate(outdatedKey)}\nLEGACY DEFAULT`;
    const outdatedHash = sha256(outdatedPrompt.trimEnd());
    const outdatedBody = [
      `<!-- bosun prompt: ${outdatedKey} -->`,
      `<!-- bosun description: test -->`,
      `<!-- bosun default-sha256: ${outdatedHash} -->`,
      "",
      outdatedPrompt,
      "",
    ].join("\n");
    await writeFile(resolve(workspace, outdatedFilename), outdatedBody, "utf8");

    const reviewKey = "taskExecutor";
    const reviewFilename = "task-executor.md";
    const reviewBase = `${getDefaultPromptTemplate(reviewKey)}\nLEGACY DEFAULT`;
    const reviewRecordedHash = sha256(reviewBase.trimEnd());
    const reviewBody = [
      `<!-- bosun prompt: ${reviewKey} -->`,
      `<!-- bosun description: test -->`,
      `<!-- bosun default-sha256: ${reviewRecordedHash} -->`,
      "",
      `${reviewBase}\nUSER MODIFICATION`,
      "",
    ].join("\n");
    await writeFile(resolve(workspace, reviewFilename), reviewBody, "utf8");

    const result = applyPromptDefaultUpdates(root, {
      keys: ["orchestrator", "taskExecutor", "reviewer"],
    });

    expect(result.updated).toEqual(
      expect.arrayContaining(["orchestrator", "reviewer"]),
    );
    expect(result.updated).not.toContain("taskExecutor");

    const skipReasons = new Map(result.skipped.map((entry) => [entry.key, entry.reason]));
    expect(skipReasons.get("taskExecutor")).toBe("modified");

    const updatedOrchestrator = await readFile(resolve(workspace, outdatedFilename), "utf8");
    const currentOrchestratorHash = sha256(getDefaultPromptTemplate("orchestrator").trimEnd());
    expect(updatedOrchestrator).toContain(
      `<!-- bosun default-sha256: ${currentOrchestratorHash} -->`,
    );
    expect(updatedOrchestrator).toContain(getDefaultPromptTemplate("orchestrator").trimEnd());

    const unchangedTaskExecutor = await readFile(resolve(workspace, reviewFilename), "utf8");
    expect(unchangedTaskExecutor).toContain("USER MODIFICATION");

    const reviewer = await readFile(resolve(workspace, "reviewer.md"), "utf8");
    const reviewerHash = sha256(getDefaultPromptTemplate("reviewer").trimEnd());
    expect(reviewer).toContain(`<!-- bosun default-sha256: ${reviewerHash} -->`);
  });
});
