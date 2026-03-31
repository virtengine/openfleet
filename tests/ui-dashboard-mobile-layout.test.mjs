import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentsCss = readFileSync(resolve(process.cwd(), "ui/styles/components.css"), "utf8");

describe("dashboard mobile layout polish", () => {
  it("adds narrow-screen spacing and card density rules for the dashboard", () => {
    expect(componentsCss).toContain("@media (max-width: 480px)");
    expect(componentsCss).toContain(".dashboard-shell");
    expect(componentsCss).toContain(".dashboard-header-meta");
    expect(componentsCss).toContain(".dashboard-card");
  });

  it("keeps mobile dashboard action controls in a two-column grid", () => {
    expect(componentsCss).toContain(".dashboard-actions-grid");
    expect(componentsCss).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(componentsCss).toContain(".dashboard-action-btn");
    expect(componentsCss).toContain("min-height: 108px;");
  });
});
