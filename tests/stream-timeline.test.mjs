import { describe, expect, it } from "vitest";
import { buildTraceTimelineBlocks } from "../ui/modules/stream-timeline.js";

describe("stream timeline helpers", () => {
  it("groups consecutive thinking trace events together", () => {
    const blocks = buildTraceTimelineBlocks([
      {
        type: "system",
        content: "Planning the edit strategy",
        timestamp: "2026-03-20T01:00:00.000Z",
      },
      {
        type: "system",
        content: "Inspecting ui/components/chat-view.js",
        timestamp: "2026-03-20T01:00:01.000Z",
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].phase).toBe("thinking");
    expect(blocks[0].entries).toHaveLength(2);
    expect(blocks[0].summary).toContain("thinking");
  });

  it("pairs read-style tool calls with outputs as file exploration blocks", () => {
    const blocks = buildTraceTimelineBlocks([
      {
        type: "tool_call",
        content: "read_file(ui/components/chat-view.js)",
        meta: { toolName: "read_file" },
        timestamp: "2026-03-20T01:00:02.000Z",
      },
      {
        type: "tool_result",
        content: "const TraceEvent = memo(...)",
        timestamp: "2026-03-20T01:00:03.000Z",
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].phase).toBe("file_exploration");
    expect(blocks[0].entries.map((entry) => entry.phase)).toEqual(["tool_call", "output"]);
    expect(blocks[0].chips).toContain("read_file");
    expect(blocks[0].chips).toContain("ui/components/chat-view.js");
  });

  it("classifies apply_patch style calls as patch result blocks", () => {
    const blocks = buildTraceTimelineBlocks([
      {
        type: "tool_call",
        content: "*** Begin Patch\n*** Update File: ui/components/chat-view.js\n*** End Patch\n",
        meta: { toolName: "apply_patch" },
        timestamp: "2026-03-20T01:00:04.000Z",
      },
      {
        type: "tool_result",
        content: "Patch applied successfully.",
        timestamp: "2026-03-20T01:00:05.000Z",
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].phase).toBe("patch_result");
    expect(blocks[0].title).toContain("ui/components/chat-view.js");
    expect(blocks[0].chips).toContain("apply_patch");
    expect(blocks[0].chips).toContain("1 output");
  });

  it("treats rg-style command executions as file exploration and preserves status chips", () => {
    const blocks = buildTraceTimelineBlocks([
      {
        type: "tool_call",
        content: "rg --files ui/components [completed, exit=0]\nui/components/chat-view.js",
        meta: { toolName: "command_execution" },
        timestamp: "2026-03-20T01:00:06.000Z",
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].phase).toBe("file_exploration");
    expect(blocks[0].chips).toContain("completed");
    expect(blocks[0].chips).toContain("exit=0");
  });

  it("emits file change trace items as patch result blocks", () => {
    const blocks = buildTraceTimelineBlocks([
      {
        type: "system",
        content: "Planning the update",
        timestamp: "2026-03-20T01:00:06.000Z",
      },
      {
        type: "system",
        content: "*** Begin Patch\n*** Update File: ui/components/chat-view.js\n*** End Patch\n",
        meta: { itemType: "file_change" },
        timestamp: "2026-03-20T01:00:07.000Z",
      },
      {
        type: "system",
        content: "Verifying the result",
        timestamp: "2026-03-20T01:00:08.000Z",
      },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].phase).toBe("thinking");
    expect(blocks[1].phase).toBe("patch_result");
    expect(blocks[1].title).toContain("ui/components/chat-view.js");
    expect(blocks[2].phase).toBe("thinking");
  });

  it("keeps errors attached to their tool block when they arrive after the call", () => {
    const blocks = buildTraceTimelineBlocks([
      {
        type: "tool_call",
        content: "apply_patch(...)",
        meta: { toolName: "apply_patch" },
        timestamp: "2026-03-20T01:00:07.000Z",
      },
      {
        type: "error",
        content: "Patch failed: hunk did not match",
        timestamp: "2026-03-20T01:00:08.000Z",
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].hasError).toBe(true);
    expect(blocks[0].entries.map((entry) => entry.phase)).toEqual(["tool_call", "error"]);
  });
});
