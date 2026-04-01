import { describe, expect, it } from "vitest";

import { rankFuzzyMatches } from "../../tui/lib/fuzzy-score.mjs";
import { getNextScreenForInput } from "../../tui/lib/navigation.mjs";
import { renderSparkline } from "../../tui/lib/sparkline.mjs";

describe("tui utility helpers", () => {
  it("renders a sparkline from numeric samples", () => {
    expect(renderSparkline([0, 5, 10, 15, 20, 25, 30, 35])).toBe("▁▂▃▄▅▆▇█");
    expect(renderSparkline([7, 7, 7])).toBe("███");
    expect(renderSparkline([])).toBe("");
  });

  it("ranks fuzzy matches by closeness", () => {
    const ranked = rankFuzzyMatches("agt", [
      "active agents",
      "task board",
      "agent activity",
      "workflow runs",
    ]);

    expect(ranked.map((entry) => entry.item)).toEqual([
      "agent activity",
      "active agents",
      "task board",
      "workflow runs",
    ]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("updates the active screen from navigation key presses", () => {
    expect(getNextScreenForInput("status", "2")).toBe("tasks");
    expect(getNextScreenForInput("tasks", "3")).toBe("agents");
    expect(getNextScreenForInput("agents", "1")).toBe("status");
    expect(getNextScreenForInput("logs", "5")).toBe("workflows");
    expect(getNextScreenForInput("workflows", "6")).toBe("telemetry");
    expect(getNextScreenForInput("telemetry", "7")).toBe("settings");
    expect(getNextScreenForInput("agents", "x")).toBe("agents");
  });
});
