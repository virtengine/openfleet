import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const DASHBOARD_PATH = "dashboards/grafana-bosun-otel-dashboard.json";

describe("grafana OTel dashboard", () => {
  it("includes the expected Bosun observability panels", () => {
    expect(existsSync(DASHBOARD_PATH)).toBe(true);
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8"));
    const titles = dashboard.panels.map((panel) => panel.title);
    expect(titles).toEqual(expect.arrayContaining([
      "Task Throughput",
      "Task Success Rate",
      "Average Task Duration",
      "Token Usage By Model",
      "Cost By Model / SDK",
      "Error Rate By Type",
      "Intervention Frequency",
      "Multi-Agent Waterfall",
    ]));
  });
});
