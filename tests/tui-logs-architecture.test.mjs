import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tui logs architecture scaffold", () => {
  const cwd = process.cwd();
  const appSource = readFileSync(resolve(cwd, "tui/app.mjs"), "utf8");
  const navSource = readFileSync(resolve(cwd, "tui/lib/navigation.mjs"), "utf8");

  it("registers a logs screen and logs tab in the main app", () => {
    expect(appSource).toContain('import LogsScreen from "./screens/logs.mjs"');
    expect(appSource).toContain("logs: LogsScreen");
    expect(appSource).toContain('{ key: "logs", num: "5", label: "Logs" }');
    expect(appSource).toContain('on("logs:stream"');
    expect(appSource).toContain("logsFilterState");
  });

  it("routes numeric input 4 to the logs screen", () => {
    expect(navSource).toContain('const SCREEN_ORDER = ["status", "tasks", "agents", "telemetry", "logs"]');
    expect(navSource).toContain('["5", "logs"]');
  });
});
