import React from "react";
import { describe, expect, it } from "vitest";

import StatusHeader, {
  formatTokenSummary,
} from "../../tui/components/status-header.mjs";
import { FIXTURE_STATS } from "./fixtures.mjs";
import { renderInk } from "./render-ink.mjs";

describe("tui status header", () => {
  it("formats token totals consistently", () => {
    expect(formatTokenSummary(FIXTURE_STATS)).toBe("1.2K in / 5.7K out / 6.9K total");
  });

  it("renders connection state and token summary", async () => {
    const view = await renderInk(
      React.createElement(StatusHeader, {
        stats: FIXTURE_STATS,
        connected: true,
        screen: "status",
      }),
    );

    expect(view.text()).toContain("Bosun TUI");
    expect(view.text()).toContain("Connected");
    expect(view.text()).toContain("Tokens: 1.2K in / 5.7K out / 6.9K total");
    expect(view.text()).toContain("[1] Status");

    await view.unmount();
  });
});