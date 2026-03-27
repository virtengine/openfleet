import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = new Set();
const spawnedChildren = new Set();

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function reserveFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to determine a free port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForStartupSignal(child, signalPath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(signalPath)) {
      return { started: true, exited: false };
    }
    if (child.exitCode !== null) {
      return { started: false, exited: true };
    }
    await sleep(100);
  }
  return {
    started: existsSync(signalPath),
    exited: child.exitCode !== null,
  };
}

async function stopChildProcess(child, timeoutMs = 5000) {
  if (child?.exitCode !== null) return;

  child.kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    const killDeadline = Date.now() + 2000;
    while (child.exitCode === null && Date.now() < killDeadline) {
      await sleep(50);
    }
  }
}

afterEach(() => {
  for (const child of spawnedChildren) {
    try {
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      /* best effort */
    }
  }
  spawnedChildren.clear();
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
  tempDirs.clear();
});

describe("cli workspace config-dir resolution", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");
  const workspaceSection = cliSource.slice(
    cliSource.indexOf("// Handle workspace commands"),
    cliSource.indexOf("// Handle --setup-terminal (legacy terminal wizard)"),
  );

  it("uses resolveConfigDirForCli fallback for workspace commands", () => {
    const expected =
      "configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli()";
    const matches = workspaceSection.split(expected).length - 1;

    expect(matches).toBeGreaterThanOrEqual(1);
    expect(workspaceSection).not.toContain('resolve(os.homedir(), "bosun")');
  });

  it("checks existing monitor locks using configured runtime cache dirs", () => {
    expect(cliSource).toContain("const configuredCacheDirs = await getConfiguredRuntimeCacheDirs();");
    expect(cliSource).toContain("detectExistingMonitorLockOwner(null, configuredCacheDirs)");
    expect(cliSource).toContain("function detectExistingMonitorLockOwner(excludePid = null, extraCacheDirs = [])");
  });

  it("prefers repo-local .bosun for --where when repo root is provided", () => {
    const repoRoot = makeTempDir("bosun-cli-config-dir-");
    const repoConfigDir = resolve(repoRoot, ".bosun");
    mkdirSync(repoConfigDir, { recursive: true });
    writeFileSync(resolve(repoConfigDir, "bosun.config.json"), "{}", "utf8");

    const env = { ...process.env };
    delete env.BOSUN_HOME;
    delete env.BOSUN_DIR;
    env.APPDATA = resolve(repoRoot, "appdata");
    env.LOCALAPPDATA = env.APPDATA;
    env.USERPROFILE = env.APPDATA;
    env.HOME = env.APPDATA;
    env.XDG_CONFIG_HOME = env.APPDATA;

    const output = execFileSync(process.execPath, ["cli.mjs", "--where", "--repo-root", repoRoot], {
      cwd: resolve(process.cwd()),
      env,
      encoding: "utf8",
    });

    expect(output).toContain(repoConfigDir);
  });

  it("boots the monitor without crashing during CLI startup", async () => {
    const runtimeRoot = makeTempDir("bosun-cli-runtime-");
    const configDir = makeTempDir("bosun-cli-home-");
    const homeDir = resolve(configDir, "home");
    const appDataDir = resolve(homeDir, "AppData", "Roaming");
    const localAppDataDir = resolve(homeDir, "AppData", "Local");
    const xdgConfigDir = resolve(homeDir, ".config");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(localAppDataDir, { recursive: true });
    mkdirSync(xdgConfigDir, { recursive: true });

    writeFileSync(
      resolve(configDir, "bosun.config.json"),
      JSON.stringify({
        projectName: "startup-smoke",
        executors: [],
        interactiveShellEnabled: false,
      }, null, 2),
      "utf8",
    );

    const uiPort = await reserveFreePort();
    const agentEndpointPort = await reserveFreePort();
    const env = {
      ...process.env,
      BOSUN_DIR: configDir,
      REPO_ROOT: runtimeRoot,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      XDG_CONFIG_HOME: xdgConfigDir,
      BOSUN_CACHE_DIR: resolve(runtimeRoot, ".cache"),
      TELEGRAM_UI_PORT: String(uiPort),
      BOSUN_AGENT_ENDPOINT_PORT: String(agentEndpointPort),
      TELEGRAM_UI_TUNNEL: "disabled",
      BOSUN_UI_AUTO_OPEN_ON_DAEMON: "false",
      BOSUN_MCP_DISABLE_DAEMON_DISCOVERY: "1",
      BOSUN_SENTINEL_AUTO_START: "0",
      BOSUN_SENTINEL_STRICT: "0",
      BOSUN_DAEMON: "0",
    };
    delete env.NODE_ENV;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    delete env.JEST_WORKER_ID;
    delete env.BOSUN_TEST_SANDBOX;
    delete env.BOSUN_TEST_SANDBOX_ROOT;

    const cliPath = resolve(process.cwd(), "cli.mjs");
    const child = spawn(
      process.execPath,
      [cliPath, "--no-telegram-bot", "--no-update-check", "--no-auto-update"],
      {
        cwd: runtimeRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    spawnedChildren.add(child);

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });

    try {
      const pidFile = resolve(runtimeRoot, ".cache", "bosun.pid");
      const startup = await waitForStartupSignal(child, pidFile, 20000);
      const duplicateGuardTriggered = /bosun is already running \(PID \d+\); exiting duplicate start\./i.test(output);

      if (duplicateGuardTriggered) {
        expect(startup.started, `Duplicate guard should prevent monitor bootstrap. Output:\n${output}`).toBe(false);
        expect(child.exitCode, `Duplicate guard should exit cleanly. Output:\n${output}`).toBe(0);
      } else {
        expect(startup.started, `Bosun never reached monitor bootstrap. Output:\n${output}`).toBe(true);
        expect(startup.exited, `Bosun exited before monitor bootstrap completed. Output:\n${output}`).toBe(false);

        await sleep(1500);

        expect(
          child.exitCode,
          `Bosun crashed shortly after monitor bootstrap. Output:\n${output}`,
        ).toBeNull();
        expect(output).not.toMatch(/Monitor failed to start|bosun failed:/i);
      }
    } finally {
      await stopChildProcess(child);
      spawnedChildren.delete(child);
    }
  }, 30000);
});

