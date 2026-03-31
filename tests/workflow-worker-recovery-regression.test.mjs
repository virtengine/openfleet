import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow worker recovery regressions", () => {
  const uiServerSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
  const workerSource = readFileSync(resolve(process.cwd(), "server/workflow-engine-worker.mjs"), "utf8");

  it("lets worker-backed engines detect and resume interrupted runs", () => {
    expect(workerSource).toContain("engine = wfEngineMod.getWorkflowEngine({");
    expect(workerSource).not.toContain("detectInterruptedRuns: false");
    expect(workerSource).toContain("setTimeout(() => engine.resumeInterruptedRuns().catch(() => {}), 0);");
  });

  it("returns retry payloads with retryRunId for worker-backed workflow actions", () => {
    expect(workerSource).toContain('case "retryRun": {');
    expect(workerSource).toContain("retryRunId: retryResult?.retryRunId || retryResult?.ctx?.id || null");
    expect(workerSource).toContain("originalRunId: retryResult?.originalRunId || null");
    expect(workerSource).toContain("mode: retryResult?.mode || null");
  });

  it("drops dead workflow worker proxies so the UI can recreate them", () => {
    expect(uiServerSource).toContain("_handleWorkerUnavailable(err)");
    expect(uiServerSource).toContain("this._pending.clear();");
    expect(uiServerSource).toContain("isAvailable()");
    expect(uiServerSource).toContain("!engine.isAvailable()");
    expect(uiServerSource).toContain("_wfEngineByWorkspace.delete(workspaceKey);");
  });

  it("forwards agent pool bridge calls with the current prompt-plus-options signatures", () => {
    expect(workerSource).toContain('async launchOrResumeThread(prompt, cwd, timeout, opts) {');
    expect(workerSource).toContain('return callMainService("agentPool.launchOrResumeThread", [prompt, cwd, timeout, opts]);');
    expect(workerSource).toContain('async execWithRetry(prompt, opts) {');
    expect(workerSource).toContain('return callMainService("agentPool.execWithRetry", [prompt, opts]);');
    expect(uiServerSource).toContain("_normalizeAgentPoolBridgeArgs(fn, args = [])");
    expect(uiServerSource).toContain("options.slotMeta?.taskKey ||");
    expect(uiServerSource).toContain("options.targetTaskKey ||");
    expect(uiServerSource).toContain("const normalizedArgs = this._normalizeAgentPoolBridgeArgs(fn, args);");
    expect(uiServerSource).toContain('if (fn === "execWithRetry")         return execWithRetry(normalizedArgs[0], normalizedArgs[1] || {});');
  });
});
