import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowContext } from "../workflow/workflow-engine.mjs";
import { getNodeType } from "../workflow/workflow-nodes.mjs";

describe("action.write_file encoding repair", () => {
  let tempDir = "";

  afterEach(() => {
    if (!tempDir) return;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
    tempDir = "";
  });

  it("repairs common mojibake before writing files", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "wf-write-file-encoding-"));
    const filePath = join(tempDir, "sample.txt");
    const handler = getNodeType("action.write_file");
    const ctx = new WorkflowContext({});
    ctx.log = () => {};

    const result = await handler.execute({
      id: "write-file",
      type: "action.write_file",
      config: {
        path: filePath,
        content: "VALIDATION  ÔÇö Verification gates\nexecute(node, ctx) ÔåÆ Promise<any>",
      },
    }, ctx, {});

    expect(result.success).toBe(true);
    expect(result.repairedMojibake).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(
      "VALIDATION  — Verification gates\nexecute(node, ctx) → Promise<any>",
    );
  });
});
