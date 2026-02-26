import { describe, expect, it } from "vitest";

import {
  extractPlannerTasksFromOutput,
  formatCodexResult,
} from "../scripts/bosun/monitor.mjs""48;

describe("task planner codex-sdk output parsing", () => {
  it("parses tasks from codex-sdk run() finalResponse payload", () => {
    const codexRunResult = {
      items: [],
      finalResponse: `\`\`\`json
{
  "tasks": [
    {
      "title": "[m] fix(bosun): parse planner tasks from codex finalResponse",
      "description": "Planner output should materialize into backlog tasks.",
      "implementation_steps": ["Update parser"],
      "acceptance_criteria": ["Planner creates tasks"],
      "verification": ["Run planner test"]
    }
  ]
}
\`\`\``,
      usage: null,
    };

    const output = formatCodexResult(codexRunResult);
    const tasks = extractPlannerTasksFromOutput(output, 5);

    expect(output).toContain('"tasks"');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toContain(
      "fix(bosun): parse planner tasks from codex finalResponse",
    );
  });
});
