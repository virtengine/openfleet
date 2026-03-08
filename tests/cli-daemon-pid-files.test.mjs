import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli daemon pid tracking", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

  it("uses a dedicated daemon pid file separate from monitor lock pid file", () => {
    expect(cliSource).toContain(
      "const runtimeCacheDir = resolve(runtimeRepoRoot, \".cache\");",
    );
    expect(cliSource).toContain(
      'const PID_FILE = resolve(runtimeCacheDir, "bosun.pid");',
    );
    expect(cliSource).toContain(
      'const DAEMON_PID_FILE = resolve(runtimeCacheDir, "bosun-daemon.pid");',
    );
    expect(cliSource).toContain(
      'async function getConfiguredRuntimeCacheDirs() {',
    );
  });

  it("reads and writes daemon state via the dedicated daemon pid file", () => {
    expect(cliSource).toContain(
      "readAlivePid(DAEMON_PID_FILE) || readAlivePid(LEGACY_DAEMON_PID_FILE)",
    );
    expect(cliSource).toContain(
      "writeFileSync(DAEMON_PID_FILE, String(pid), \"utf8\");",
    );
    expect(cliSource).toContain("if (existsSync(DAEMON_PID_FILE)) unlinkSync(DAEMON_PID_FILE);");
    expect(cliSource).toContain("if (existsSync(LEGACY_DAEMON_PID_FILE)) unlinkSync(LEGACY_DAEMON_PID_FILE);");
  });

  it("resolves terminate pid candidates from configured cache dirs before relying on process scans", () => {
    expect(cliSource).toContain(
      'const { loadConfig } = await import("./config/config.mjs");',
    );
    expect(cliSource).toContain('String(config?.cacheDir || "").trim() || null');
    expect(cliSource).toContain(
      '...getPidFileCandidates("bosun-daemon.pid", configuredCacheDirs).map(',
    );
    expect(cliSource).toContain(
      '...getMonitorPidFileCandidates(configuredCacheDirs).map((pidFile) =>',
    );
    expect(cliSource).toContain('await terminateBosun();');
    expect(cliSource).toContain('writeSentinelManualStopHold(configuredCacheDirs, manualStopHoldMs);');
  });

  it("uses Windows taskkill fallback when terminate finds stuck bosun processes", () => {
    expect(cliSource).toContain('function taskkillPid(pid, { force = false } = {}) {');
    expect(cliSource).toContain('function taskkillPidsElevated(pids, { force = false } = {}) {');
    expect(cliSource).toContain('execFileSync("taskkill", args, {');
    expect(cliSource).toContain('const args = ["/PID", String(pid)];');
    expect(cliSource).toContain('if (process.platform === "win32" && alive.length > 0) {');
    expect(cliSource).toContain('taskkillPid(pid, { force: true });');
    expect(cliSource).toContain('taskkillPidsElevated(alive, { force: true });');
  });

  it("shuts down restart-capable processes before monitor pids during terminate", () => {
    expect(cliSource).toContain('const ancestorPids = findWindowsManagedAncestorPids([');
    expect(cliSource).toContain('const restartOwnerPids = Array.from(');
    expect(cliSource).toContain('new Set([...ancestorPids, ...sentinelPids, ...daemonPids, ...ghosts])');
    expect(cliSource).toContain('for (const pid of restartOwnerPids) {');
    expect(cliSource).toContain('const remainingPids = allPids.filter((pid) => !restartOwnerPids.includes(pid));');
  });

  it("only falls back to broad process scans when lock files do not yield live Bosun pids", () => {
    expect(cliSource).toContain('const trackedPids = Array.from(new Set([...tracked, ...ghosts])).filter(');
    expect(cliSource).toContain('trackedPids.length === 0 && process.platform !== "win32"');
    expect(cliSource).toContain('? findAllBosunProcessPids()');
  });

  it("guards daemon-child startup with singleton ownership of daemon pid file", () => {
    expect(cliSource).toContain("const existingDaemonPid = getDaemonPid();");
    expect(cliSource).toContain("duplicate daemon-child ignored");
  });


  it("propagates --config-dir/BOSUN_HOME into daemon-child env config dir", () => {
    expect(cliSource).toContain("const configDirArg = getArgValue(\"--config-dir\");");
    expect(cliSource).toContain("if (configDirArg) return resolve(configDirArg);");
    expect(cliSource).toContain("if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);");
    expect(cliSource).toContain("BOSUN_DIR: process.env.BOSUN_DIR || resolveConfigDirForCli(),");
    expect(cliSource).toContain("function normalizeDetachedDaemonArgs(rawArgs = []) {");
    expect(cliSource).toContain("...normalizeDetachedDaemonArgs(");
  });
  it("supports windows ghost daemon discovery for --daemon-status/--stop-daemon", () => {
    expect(cliSource).toContain("if (process.platform === \"win32\")");
    expect(cliSource).toContain("Get-CimInstance Win32_Process");
    expect(cliSource).toContain("--daemon-child");
  });

  it("keeps sentinel companion auto-start opt-in to avoid Telegram polling conflicts", () => {
    expect(cliSource).toContain("const sentinelExplicit = args.includes(\"--sentinel\");");
    expect(cliSource).toContain("const sentinelRequested =");
    expect(cliSource).toContain("!IS_DAEMON_CHILD && sentinelAutoRequested");
    expect(cliSource).toContain("parseBoolEnv(");
    expect(cliSource).toContain("process.env.BOSUN_SENTINEL_AUTO_START");
    expect(cliSource).toContain(
      "telegram-sentinel auto-start suppressed in daemon-child mode",
    );
  });

  it("treats explicit --sentinel as a standalone command unless daemon mode is requested", () => {
    expect(cliSource).toContain("sentinelExplicit && !IS_DAEMON_CHILD");
    expect(cliSource).toContain(
      "Sentinel started without launching monitor (use --daemon --sentinel to run both).",
    );
    expect(cliSource).toContain("sentinelExplicit,");
  });
});
