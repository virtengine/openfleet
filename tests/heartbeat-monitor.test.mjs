import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatMonitor } from "../infra/heartbeat-monitor.mjs";

describe("heartbeat-monitor", () => {
  let sandboxDir = null;

  afterEach(() => {
    if (sandboxDir) {
      rmSync(sandboxDir, { recursive: true, force: true });
      sandboxDir = null;
    }
  });

  function createSandbox() {
    sandboxDir = mkdtempSync(join(tmpdir(), "bosun-heartbeat-monitor-"));
    const configDir = resolve(sandboxDir, "config");
    const cacheDir = resolve(configDir, ".cache");
    const logDir = resolve(sandboxDir, "logs");
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      resolve(cacheDir, "ui-last-port.json"),
      JSON.stringify({
        port: 18432,
        host: "192.168.0.183",
        protocol: "https",
        url: "https://192.168.0.183:18432",
      }, null, 2),
      "utf8",
    );
    writeFileSync(resolve(logDir, "monitor.log"), "2026-03-28T00:00:00.000Z [INFO] monitor heartbeat\n", "utf8");
    writeFileSync(resolve(logDir, "monitor-error.log"), "2026-03-28T00:00:01.000Z [ERROR] workflow timeout\n", "utf8");
    return { configDir, cacheDir, logDir };
  }

  it("logs timeout probes with correlated monitor log tails", async () => {
    const { configDir, cacheDir, logDir } = createSandbox();
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const monitor = createHeartbeatMonitor({
      configDir,
      logDir,
      timeoutMs: 25,
      fetchImpl,
      logger: { warn: vi.fn() },
    });

    const result = await monitor.probeNow("timeout-test");
    const logPath = monitor.getSnapshot().logPath;

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("timeout");
    expect(existsSync(logPath)).toBe(true);

    const entries = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toEqual(
      expect.objectContaining({
        trigger: "timeout-test",
        outcome: "timeout",
        port: 18432,
        url: "https://192.168.0.183:18432/healthz",
        correlatedLogs: expect.objectContaining({
          monitorLogTail: expect.stringContaining("monitor heartbeat"),
          monitorErrorLogTail: expect.stringContaining("workflow timeout"),
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://192.168.0.183:18432/healthz",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );

    expect(existsSync(resolve(cacheDir, "ui-last-port.json"))).toBe(true);
  });

  it("logs a recovered heartbeat after a prior timeout", async () => {
    const { configDir, logDir } = createSandbox();
    let shouldTimeout = true;
    const fetchImpl = vi.fn(() => {
      if (!shouldTimeout) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: "ok", monitor: "running", server: "running" }),
        });
      }
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });
    const monitor = createHeartbeatMonitor({
      configDir,
      logDir,
      timeoutMs: 25,
      successLogIntervalMs: 1000,
      fetchImpl,
      logger: { warn: vi.fn() },
    });

    await monitor.probeNow("timeout-before-recovery");
    shouldTimeout = false;
    const recovered = await monitor.probeNow("recovery-test");

    expect(recovered.ok).toBe(true);

    const entries = readFileSync(monitor.getSnapshot().logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toEqual(
      expect.objectContaining({
        trigger: "recovery-test",
        outcome: "recovered",
        previousOutcome: "timeout",
        statusCode: 200,
      }),
    );
  });
});
