import { describe, expect, it } from "vitest";

import { classifyMonitorCommandLine } from "../maintenance.mjs";

describe("monitor lock command-line classification", () => {
  it("classifies absolute monitor path as monitor", () => {
    const cmd = "C:/Program Files/nodejs/node.exe C:/repos/bosun/monitor.mjs";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies relative node monitor launch as monitor", () => {
    const cmd = "node monitor.mjs --self-restart";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies cli monitorMonitor launch as monitor", () => {
    const cmd = "node C:/repos/bosun/cli.mjs monitorMonitor";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies unrelated process as other", () => {
    const cmd = "python -m http.server 18432";
    expect(classifyMonitorCommandLine(cmd)).toBe("other");
  });
});
