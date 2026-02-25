import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  acquireMonitorLock,
  classifyMonitorCommandLine,
  shouldAssumeMonitorForUnknownOwner,
} from "../maintenance.mjs";

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
  test("replaces same-pid lock when owner token mismatches", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");
    const stalePayload = {
      pid: process.pid,
      started_at: "2001-01-01T00:00:00.000Z",
      argv: ["node", "monitor.mjs"],
      lock_token: "foreign-token",
    };

    await writeFile(pidFile, JSON.stringify(stalePayload, null, 2), "utf8");

    assert.equal(acquireMonitorLock(lockDir), true);

    const freshPayload = JSON.parse(await readFile(pidFile, "utf8"));
    assert.equal(freshPayload.pid, process.pid);
    assert.equal(typeof freshPayload.lock_token, "string");
    assert.notEqual(freshPayload.lock_token, stalePayload.lock_token);
    assert.notEqual(freshPayload.started_at, stalePayload.started_at);
  });

  test("is re-entrant for the same process lock owner", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");

    assert.equal(acquireMonitorLock(lockDir), true);
    const firstPayload = JSON.parse(await readFile(pidFile, "utf8"));

    assert.equal(acquireMonitorLock(lockDir), true);
    const secondPayload = JSON.parse(await readFile(pidFile, "utf8"));

    assert.deepEqual(secondPayload, firstPayload);
  });

  test("replaces same-pid pre-token lock files with mismatched start time", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");
    const preTokenPayload = {
      pid: process.pid,
      started_at: "1999-01-01T00:00:00.000Z",
      argv: ["node", "monitor.mjs"],
    };

    await writeFile(pidFile, JSON.stringify(preTokenPayload, null, 2), "utf8");

    assert.equal(acquireMonitorLock(lockDir), true);

    const payload = JSON.parse(await readFile(pidFile, "utf8"));
    assert.equal(payload.pid, process.pid);
    assert.equal(typeof payload.lock_token, "string");
    assert.ok(payload.lock_token.length > 0);
    assert.notEqual(payload.started_at, preTokenPayload.started_at);
  });

  test("replaces stale lock files that reference dead processes", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");

    await writeFile(pidFile, "2147483647", "utf8");

    assert.equal(acquireMonitorLock(lockDir), true);

    const payload = JSON.parse(await readFile(pidFile, "utf8"));
    assert.equal(payload.pid, process.pid);
    assert.equal(typeof payload.lock_token, "string");
    assert.ok(payload.lock_token.length > 0);
  });

  test("replaces malformed lock files", async () => {
    const pidFile = resolve(lockDir, "bosun.pid");

    await writeFile(pidFile, "{not-json", "utf8");

    assert.equal(acquireMonitorLock(lockDir), true);

    const payload = JSON.parse(await readFile(pidFile, "utf8"));
    assert.equal(payload.pid, process.pid);
    assert.equal(Array.isArray(payload.argv), true);
  });

  test("does not block startup on unexpected lock write errors", async () => {
    const notADirectoryPath = resolve(lockDir, "occupied-path");

    await writeFile(notADirectoryPath, "occupied", "utf8");

    // openSync(<file>/bosun.pid, "wx") fails with ENOTDIR on most platforms.
    assert.equal(acquireMonitorLock(notADirectoryPath), true);
  });
});

describe("classifyMonitorCommandLine", () => {
  test("returns unknown for empty command lines", () => {
    assert.equal(classifyMonitorCommandLine(""), "unknown");
    assert.equal(classifyMonitorCommandLine("   "), "unknown");
  });

  test("classifies monitor process using canonical marker", () => {
    const cmd = "node C:/repos/bosun/monitor.mjs --watch";
    assert.equal(classifyMonitorCommandLine(cmd), "monitor");
  });

  test("classifies monitor process from relative dev launch", () => {
    const cmd = "node monitor.mjs --self-restart";
    assert.equal(classifyMonitorCommandLine(cmd), "monitor");
  });

  test("classifies monitor process from cli monitorMonitor flow", () => {
    const cmd = "node C:/repos/bosun/cli.mjs monitorMonitor";
    assert.equal(classifyMonitorCommandLine(cmd), "monitor");
  });

  test("classifies non-monitor command lines as other", () => {
    const cmd = "python -m http.server 18432";
    assert.equal(classifyMonitorCommandLine(cmd), "other");
  });
});

describe("shouldAssumeMonitorForUnknownOwner", () => {
  test("returns false when lock metadata does not resemble monitor ownership", () => {
    const now = Date.parse("2026-02-25T00:00:00.000Z");
    const payload = {
      argv: ["node", "worker.mjs"],
      started_at: "2026-02-25T00:00:00.000Z",
    };

    assert.equal(shouldAssumeMonitorForUnknownOwner(payload, now), false);
  });

  test("returns true when monitor-like payload has invalid start time", () => {
    const now = Date.parse("2026-02-25T00:00:00.000Z");
    const payload = {
      argv: ["node", "monitor.mjs"],
      started_at: "not-a-date",
    };

    assert.equal(shouldAssumeMonitorForUnknownOwner(payload, now), true);
  });

  test("returns true for monitor-like payloads inside the grace window", () => {
    const now = Date.parse("2026-02-25T00:03:00.000Z");
    const payload = {
      argv: ["node", "monitor.mjs"],
      started_at: "2026-02-25T00:01:30.000Z",
    };

    assert.equal(shouldAssumeMonitorForUnknownOwner(payload, now), true);
  });

  test("returns false for monitor-like payloads outside the grace window", () => {
    const now = Date.parse("2026-02-25T00:10:00.000Z");
    const payload = {
      argv: ["node", "monitor.mjs"],
      started_at: "2026-02-25T00:00:00.000Z",
    };

    assert.equal(shouldAssumeMonitorForUnknownOwner(payload, now), false);
  });
});
