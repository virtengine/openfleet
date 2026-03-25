import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tui workflows screen architecture", () => {
  const appSource = readFileSync(resolve(process.cwd(), "ui/tui/App.js"), "utf8");

  it("mounts a dedicated workflows screen instead of a simple table", () => {
    expect(appSource).toContain('./WorkflowsScreen.js');
    expect(appSource).toContain('<${WorkflowsScreen}');
    expect(appSource).not.toContain('title="Workflows"\n        subtitle=${workflowState.loading ? "Loading configured workflows…"');
  });

  it("keeps workflows in the tab order", async () => {
    const constants = await import("../ui/tui/constants.js");
    expect(constants.TAB_ORDER.some((tab) => tab.id === "workflows")).toBe(true);
  });
});
