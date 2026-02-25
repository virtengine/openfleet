import { describe, expect, it } from "vitest";

import {
  classifyMonitorCommandLine,
  shouldAssumeMonitorForUnknownOwner,
} from "../maintenance.mjs";

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

describe("unknown lock owner fallback", () => {
  const nowMs = Date.parse("2026-02-25T15:30:00.000Z");

  it("assumes monitor for recent monitor-like PID payload", () => {
    const pidFileData = {
      argv: ["node", "C:/repos/bosun/monitor.mjs"],
      started_at: "2026-02-25T15:28:30.000Z",
    };
    expect(shouldAssumeMonitorForUnknownOwner(pidFileData, nowMs)).toBe(true);
  });

  it("does not assume monitor for stale monitor-like PID payload", () => {
    const pidFileData = {
      argv: ["node", "C:/repos/bosun/monitor.mjs"],
      started_at: "2026-02-25T15:20:00.000Z",
    };
    expect(shouldAssumeMonitorForUnknownOwner(pidFileData, nowMs)).toBe(false);
  });

  it("does not assume monitor when argv does not look like monitor", () => {
    const pidFileData = {
      argv: ["python", "-m", "http.server"],
      started_at: "2026-02-25T15:29:00.000Z",
    };
    expect(shouldAssumeMonitorForUnknownOwner(pidFileData, nowMs)).toBe(false);
  });
});
