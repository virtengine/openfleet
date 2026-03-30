import { describe, expect, it } from "vitest";

import { buildTaskContextBlock } from "../workflow/workflow-nodes/definitions.mjs";

describe("workflow task context", () => {
  it("includes persisted review findings ahead of comments and attachments", () => {
    const block = buildTaskContextBlock({
      reviewStatus: "changes_requested",
      reviewIssues: [
        {
          severity: "major",
          category: "bug",
          file: "server/api.mjs",
          line: 42,
          description: "Validation rejects valid payloads.",
        },
      ],
      comments: [
        {
          author: "reviewer",
          createdAt: "2026-03-01T00:00:00.000Z",
          body: "Please fix validation and rerun tests.",
        },
      ],
    });

    expect(block).toContain("## Task Context");
    expect(block).toContain("### Review Findings");
    expect(block).toContain("[major/bug] server/api.mjs:42 - Validation rejects valid payloads.");
    expect(block.indexOf("### Review Findings")).toBeLessThan(block.indexOf("### Comments"));
  });
});