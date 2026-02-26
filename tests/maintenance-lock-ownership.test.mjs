import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  acquireMonitorLock,
  classifyMonitorCommandLine,
  shouldAssumeMonitorForUnknownOwner,
} from "../scripts/bosun/core/maintenance.mjs";

let lockDir;
let previousMaxListeners;

beforeEach(async () => {
  lockDir = await mkdtemp(resolve(tmpdir(), "bosun-lock-owner-"));
});

afterEach(async () => {
  if (lockDir) {
    await rm(lockDir, { recursive: true, force: true });
  }
});

// acquireMonitorLock registers process-level cleanup listeners per successful lock write.
// Raise the limit to keep this suite warning-free while exercising multiple scenarios.
beforeEach(() => {
  previousMaxListeners = process.getMaxListeners();
  process.setMaxListeners(previousMaxListeners + 20);
});

afterEach(() => {
  process.setMaxListeners(previousMaxListeners);
});

describe("acquireMonitorLock", () => {
  it("replaces same-pid lock when owner token mismatches", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");
    const stalePayload = {
      pid: process.pid,
      started_at: "2001-01-01T00:00:00.000Z",
      argv: ["node", "monitor.mjs"],
      lock_token: "foreign-token",
    };

    await writeFile(pidFile, JSON.stringify(stalePayload, null, 2), "utf8");

    expect(acquireMonitorLock(lockDir)).toBe(true);

    const freshPayload = JSON.parse(await readFile(pidFile, "utf8"));
    expect(freshPayload.pid).toBe(process.pid);
    expect(typeof freshPayload.lock_token).toBe("string");
    expect(freshPayload.lock_token).not.toBe(stalePayload.lock_token);
    expect(freshPayload.started_at).not.toBe(stalePayload.started_at);
  });

  it("is re-entrant for the same process lock owner", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");

    expect(acquireMonitorLock(lockDir)).toBe(true);
    const firstPayload = JSON.parse(await readFile(pidFile, "utf8"));

    expect(acquireMonitorLock(lockDir)).toBe(true);
    const secondPayload = JSON.parse(await readFile(pidFile, "utf8"));

    expect(secondPayload).toEqual(firstPayload);
  });

  it("replaces same-pid pre-token lock files with mismatched start time", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");
    const preTokenPayload = {
      pid: process.pid,
      started_at: "1999-01-01T00:00:00.000Z",
      argv: ["node", "monitor.mjs"],
    };

    await writeFile(pidFile, JSON.stringify(preTokenPayload, null, 2), "utf8");

    expect(acquireMonitorLock(lockDir)).toBe(true);

    const payload = JSON.parse(await readFile(pidFile, "utf8"));
    expect(payload.pid).toBe(process.pid);
    expect(typeof payload.lock_token).toBe("string");
    expect(payload.lock_token.length).toBeGreaterThan(0);
    expect(payload.started_at).not.toBe(preTokenPayload.started_at);
  });

  it("replaces stale lock files that reference dead processes", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");

    await writeFile(pidFile, "2147483647", "utf8");

    expect(acquireMonitorLock(lockDir)).toBe(true);

    const payload = JSON.parse(await readFile(pidFile, "utf8"));
    expect(payload.pid).toBe(process.pid);
    expect(typeof payload.lock_token).toBe("string");
    expect(payload.lock_token.length).toBeGreaterThan(0);
  });

  it("replaces malformed lock files", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");

    await writeFile(pidFile, "{not-json", "utf8");

    expect(acquireMonitorLock(lockDir)).toBe(true);

    const payload = JSON.parse(await readFile(pidFile, "utf8"));
    expect(payload.pid).toBe(process.pid);
    expect(Array.isArray(payload.argv)).toBe(true);
  });

  it("does not block startup on unexpected lock write errors", async () => {
    const notADirectoryPath = resolve(lockDir, "occupied-path");

    await writeFile(notADirectoryPath, "occupied", "utf8");

    // openSync(<file>/bosun.pid, "wx") fails with ENOTDIR on most platforms.
    expect(acquireMonitorLock(notADirectoryPath)).toBe(true);
  });
});

describe("classifyMonitorCommandLine", () => {
  it("returns unknown for empty command lines", () => {
    expect(classifyMonitorCommandLine("")).toBe("unknown");
    expect(classifyMonitorCommandLine("   ")).toBe("unknown");
  });

  it("classifies monitor process using canonical marker", () => {
    const cmd = "node C:/repos/bosun/monitor.mjs --watch";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies monitor process from relative dev launch", () => {
    const cmd = "node monitor.mjs --self-restart";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies monitor process from cli monitorMonitor flow", () => {
    const cmd = "node C:/repos/bosun/cli.mjs monitorMonitor";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies non-monitor command lines as other", () => {
    const cmd = "python -m http.server 18432";
    expect(classifyMonitorCommandLine(cmd)).toBe("other");
  });
});

describe("shouldAssumeMonitorForUnknownOwner", () => {
  it("returns false when lock metadata does not resemble monitor ownership", () => {
    const now = Date.parse("2026-02-25T00:00:00.000Z");
    const payload = {
      argv: ["node", "worker.mjs"],
      started_at: "2026-02-25T00:00:00.000Z",
    };

    expect(shouldAssumeMonitorForUnknownOwner(payload, now)).toBe(false);
  });

  it("returns true when monitor-like payload has invalid start time", () => {
    const now = Date.parse("2026-02-25T00:00:00.000Z");
    const payload = {
      argv: ["node", "monitor.mjs"],
      started_at: "not-a-date",
    };

    expect(shouldAssumeMonitorForUnknownOwner(payload, now)).toBe(true);
  });

  it("returns true for monitor-like payloads inside the grace window", () => {
    const now = Date.parse("2026-02-25T00:03:00.000Z");
    const payload = {
      argv: ["node", "monitor.mjs"],
      started_at: "2026-02-25T00:01:30.000Z",
    };

    expect(shouldAssumeMonitorForUnknownOwner(payload, now)).toBe(true);
  });

  it("returns false for monitor-like payloads outside the grace window", () => {
    const now = Date.parse("2026-02-25T00:10:00.000Z");
    const payload = {
      argv: ["node", "monitor.mjs"],
      started_at: "2026-02-25T00:00:00.000Z",
    };

    expect(shouldAssumeMonitorForUnknownOwner(payload, now)).toBe(false);
  });
});
