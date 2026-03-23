import React from "react";
import { describe, expect, it } from "vitest";

import { getNextScreenForInput } from "../../tui/lib/navigation.mjs";
import { renderSparkline } from "../../tui/lib/sparkline.mjs";
import { rankFuzzyMatches, scoreFuzzyMatch } from "../../tui/lib/fuzzy-score.mjs";
import StatusHeader from "../../tui/components/status-header.mjs";
import { monitorStatsFixture } from "./fixtures.mjs";
import { renderInk } from "./render-ink.mjs";

describe("tui unit helpers", () => {
  it("renders sparkline blocks for a numeric series", () => {
    expect(renderSparkline([0, 2, 4, 6, 8, 10])).toBe("▁▂▄▅▇█");
  });

  it("ranks fuzzy matches by relevance", () => {
    const ranked = rankFuzzyMatches("st", ["tasks", "status", "agents"]);
    expect(ranked.map((entry) => entry.candidate)).toEqual(["status", "tasks", "agents"]);
    expect(scoreFuzzyMatch("agt", "agents")).toBeGreaterThan(scoreFuzzyMatch("agt", "tasks"));
  });

  it("switches tabs from numeric navigation input", () => {
    expect(getNextScreenForInput("status", "2")).toBe("tasks");
    expect(getNextScreenForInput("tasks", "3")).toBe("agents");
    expect(getNextScreenForInput("agents", "x")).toBe("agents");
  });

  it("renders the status header token summary", async () => {
    const view = await renderInk(
      React.createElement(StatusHeader, {
        stats: monitorStatsFixture,
        connected: true,
        screen: "status",
      }),
    );

    expect(view.text()).toContain("Tokens: 12.3K in / 4.6K out / 16.9K total");
    expect(view.text()).toContain("Connected");

    await view.unmount();
  });
});
