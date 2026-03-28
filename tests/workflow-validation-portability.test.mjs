import { afterEach, describe, expect, it, vi } from "vitest";

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

import { WorkflowContext } from "../workflow/workflow-engine.mjs";
import { getNodeType } from "../workflow/workflow-nodes.mjs";

afterEach(() => {
  execSyncMock.mockReset();
});

describe("validation command portability", () => {
  it("validation.build executes npm commands through a shell", async () => {
    execSyncMock.mockReturnValue("ok");
    const handler = getNodeType("validation.build");
    const ctx = new WorkflowContext({ worktreePath: process.cwd() });

    const result = await handler.execute({
      id: "build",
      type: "validation.build",
      config: { command: "npm run build", runner: { enabled: false, runtime: "local-container" } },
    }, ctx, {});

    expect(result.passed).toBe(true);
    expect(execSyncMock).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ shell: true, cwd: process.cwd() }),
    );
  });

  it("validation.tests executes npm commands through a shell", async () => {
    execSyncMock.mockReturnValue("ok");
    const handler = getNodeType("validation.tests");
    const ctx = new WorkflowContext({ worktreePath: process.cwd() });

    const result = await handler.execute({
      id: "test",
      type: "validation.tests",
      config: { command: "npm test", runner: { enabled: false, runtime: "local-container" } },
    }, ctx, {});

    expect(result.passed).toBe(true);
    expect(execSyncMock).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ shell: true, cwd: process.cwd() }),
    );
  });
});
