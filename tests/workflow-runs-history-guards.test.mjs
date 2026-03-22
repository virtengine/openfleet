import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow runs history guards", () => {
  const engineSource = readFileSync(resolve(process.cwd(), "workflow/workflow-engine.mjs"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
  const uiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");

  it("retains more workflow history by default before truncating persisted runs", () => {
    expect(engineSource).toContain('readBoundedEnvInt("WORKFLOW_MAX_PERSISTED_RUNS", 10000, {');
  });

  it("allows workflow run API pages up to the retained history cap", () => {
    expect(serverSource).toContain("? Math.min(rawLimit, 10000)");
    expect(uiSource).toContain("const WORKFLOW_RUN_MAX_FETCH = 10000;");
  });

  it("shows a loading state instead of an empty workflow-runs screen during the first fetch", () => {
    expect(uiSource).toContain("const workflowRunsInitialLoading = signal(false);");
    expect(uiSource).toContain("workflowRunsInitialLoading.value = true;");
    expect(uiSource).toContain("Loading workflow runs...");
  });

  it("prefers the workspace mirror workflow store when the daemon is writing runs there", () => {
    expect(serverSource).toContain("function getWorkflowStoragePaths(workspaceInput = \"\")");
    expect(serverSource).toContain('resolve(configDir, "workspaces", workspaceId, repoName, ".bosun")');
    expect(serverSource).toContain('existsSync(resolve(mirrorRoot, "workflow-runs"))');
    expect(serverSource).toContain('const workflowBase = useMirrorRoot ? mirrorRoot : resolve(root, ".bosun")');
  });
});
