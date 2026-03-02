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

  it("guards daemon-child startup with singleton ownership of daemon pid file", () => {
    expect(cliSource).toContain("const existingDaemonPid = getDaemonPid();");
    expect(cliSource).toContain("duplicate daemon-child ignored");
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
