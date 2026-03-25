import React from "react";
import { describe, expect, it } from "vitest";

import StatusHeader, {
  buildStatusHeaderModel,
} from "../../tui/components/status-header.mjs";
import { FIXTURE_STATS } from "./fixtures.mjs";
import { renderInk } from "./render-ink.mjs";

describe("tui status header", () => {
  it("formats token totals consistently", () => {
    const model = buildStatusHeaderModel({
      stats: FIXTURE_STATS,
      connectionState: "connected",
    });

    expect(model.row1).toContain("Tokens: in 1.2k | out 5.7k | total 6.9k");
  });

  it("renders connection state and token summary", async () => {
    const view = await renderInk(
      React.createElement(StatusHeader, {
        stats: FIXTURE_STATS,
        connected: true,
        screen: "status",
      }),
    );

    expect(view.text()).toContain("Connected");
    expect(view.text()).toContain("Tokens: in 1.2k | out 5.7k | total 6.9k");
    expect(view.text()).toContain("Project: No project");

    await view.unmount();
  });
});