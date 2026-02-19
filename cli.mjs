#!/usr/bin/env node

/**
 * openfleet — CLI Entry Point
 *
 * Usage:
 *   openfleet                        # start with default config
 *   openfleet --setup                # run setup wizard
 *   openfleet --args "-MaxParallel 6" # pass orchestrator args
 *   openfleet --help                 # show help
 *
 * The CLI handles:
 *   1. First-run detection → auto-launches setup wizard
 *   2. Command routing (setup, help, version, main start)
 *   3. Configuration loading from config.mjs
 */

import { resolve, dirname } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { fork, spawn } from "node:child_process";
import os from "node:os";
import { createDaemonCrashTracker } from "./daemon-restart-policy.mjs";
import {
  applyAllCompatibility,
  detectLegacySetup,
  migrateFromLegacy,
} from "./compat.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArgValue(flag) {
  const match = args.find((arg) => arg.startsWith(`${flag}=`));
  if (match) {
    return match.slice(flag.length + 1).trim();
  }
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return "";
}

// ── Version (read from package.json — single source of truth) ────────────────

const VERSION = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
).version;

// ── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  openfleet v${VERSION}
  AI-powered orchestrator supervisor with executor failover, smart PR flow, and Telegram notifications.

  USAGE
    openfleet [options]

  COMMANDS
    --setup                     Run the interactive setup wizard
    --doctor                    Validate openfleet .env/config setup
    --help                      Show this help
    --version                   Show version
    --update                    Check for and install latest version
    --no-update-check           Skip automatic update check on startup
    --no-auto-update            Disable background auto-update polling
    --daemon, -d                Run as a background daemon (detached, with PID file)
    --stop-daemon               Stop a running daemon process
    --daemon-status             Check if daemon is running

  ORCHESTRATOR
    --script <path>             Path to the orchestrator script
    --args "<args>"             Arguments passed to the script (default: "-MaxParallel 6")
    --restart-delay <ms>        Delay before restart (default: 10000)
    --max-restarts <n>          Max restarts, 0 = unlimited (default: 0)

  LOGGING
    --log-dir <path>            Log directory (default: ./logs)
    --echo-logs                 Echo raw orchestrator output to console (off by default)
    --quiet, -q                 Only show warnings and errors in terminal
    --verbose, -V               Show debug-level messages in terminal
    --trace                     Show all messages including trace-level
    --log-level <level>         Set explicit log level (trace|debug|info|warn|error|silent)

  AI / CODEX
    --no-codex                  Disable Codex SDK analysis
    --no-autofix                Disable automatic error fixing
    --primary-agent <name>      Override primary agent (codex|copilot|claude)
    --shell, --interactive      Enable interactive shell mode in monitor

  TELEGRAM
    --no-telegram-bot           Disable the interactive Telegram bot
    --telegram-commands         Enable monitor-side Telegram polling (advanced)

  WHATSAPP
    --whatsapp-auth             Run WhatsApp authentication (QR code mode)
    --whatsapp-auth --pairing-code  Authenticate via pairing code instead of QR

  CONTAINERS
    Container support is configured via environment variables:
      CONTAINER_ENABLED=1       Enable container isolation for agent execution
      CONTAINER_RUNTIME=docker  Runtime to use (docker|podman|container)

  VIBE-KANBAN
    --no-vk-spawn               Don't auto-spawn Vibe-Kanban
    --vk-ensure-interval <ms>   VK health check interval (default: 60000)

  STARTUP SERVICE
    --enable-startup             Register openfleet to auto-start on login
    --disable-startup           Remove openfleet from startup services
    --startup-status            Check if startup service is installed

  SENTINEL
    --sentinel                  Start telegram-sentinel in companion mode
    --sentinel-stop             Stop a running sentinel
    --sentinel-status           Show sentinel status

  FILE WATCHING
    --no-watch                  Disable file watching for auto-restart
    --watch-path <path>         File to watch (default: script path)

  CONFIGURATION
    --config-dir <path>         Directory containing config files
    --repo-root <path>          Repository root (auto-detected)
    --project-name <name>       Project name for display
    --repo <org/repo>           GitHub repo slug
    --repo-name <name>          Select repository from multi-repo config
    --profile <name>            Environment profile selection
    --mode <name>               Override mode (virtengine/generic)

  ENVIRONMENT
    Configuration is loaded from (in priority order):
    1. CLI flags
    2. Environment variables
    3. .env file
    4. openfleet.config.json
    5. Built-in defaults

    Auto-update environment variables:
      OPENFLEET_SKIP_UPDATE_CHECK=1     Disable startup version check
      OPENFLEET_SKIP_AUTO_UPDATE=1      Disable background polling
      OPENFLEET_UPDATE_INTERVAL_MS=N    Override poll interval (default: 600000)

    See .env.example for all environment variables.

  EXECUTOR CONFIG (openfleet.config.json)
    {
      "projectName": "my-project",
      "executors": [
        { "name": "copilot-claude", "executor": "COPILOT", "variant": "CLAUDE_OPUS_4_6", "weight": 50, "role": "primary" },
        { "name": "codex-default", "executor": "CODEX", "variant": "DEFAULT", "weight": 50, "role": "backup" }
      ],
      "failover": {
        "strategy": "next-in-line",
        "maxRetries": 3,
        "cooldownMinutes": 5,
        "disableOnConsecutiveFailures": 3
      },
      "distribution": "weighted"
    }

  EXECUTOR ENV SHORTHAND
    EXECUTORS=COPILOT:CLAUDE_OPUS_4_6:50,CODEX:DEFAULT:50

  EXAMPLES
    openfleet                                          # start with defaults
    openfleet --setup                                  # interactive setup
    openfleet --script ./my-orchestrator.sh             # custom script
    openfleet --args "-MaxParallel 4" --no-telegram-bot # custom args
    openfleet --no-codex --no-autofix                  # minimal mode

  DOCS
    https://www.npmjs.com/package/@virtengine/openfleet
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// ── Daemon Mode ──────────────────────────────────────────────────────────────

const PID_FILE = resolve(__dirname, ".cache", "openfleet.pid");
const DAEMON_LOG = resolve(__dirname, "logs", "daemon.log");
const SENTINEL_PID_FILE = resolve(
  __dirname,
  "..",
  "..",
  ".cache",
  "telegram-sentinel.pid",
);
const SENTINEL_PID_FILE_LEGACY = resolve(
  __dirname,
  ".cache",
  "telegram-sentinel.pid",
);
const SENTINEL_SCRIPT_PATH = fileURLToPath(
  new URL("./telegram-sentinel.mjs", import.meta.url),
);
const IS_DAEMON_CHILD =
  args.includes("--daemon-child") || process.env.OPENFLEET_DAEMON === "1";
const DAEMON_RESTART_DELAY_MS = Math.max(
  1000,
  Number(process.env.OPENFLEET_DAEMON_RESTART_DELAY_MS || 5000) || 5000,
);
const DAEMON_MAX_RESTARTS = Math.max(
  0,
  Number(process.env.OPENFLEET_DAEMON_MAX_RESTARTS || 0) || 0,
);
const DAEMON_INSTANT_CRASH_WINDOW_MS = Math.max(
  1000,
  Number(process.env.OPENFLEET_DAEMON_INSTANT_CRASH_WINDOW_MS || 15000) ||
    15000,
);
const DAEMON_MAX_INSTANT_RESTARTS = Math.max(
  1,
  Number(process.env.OPENFLEET_DAEMON_MAX_INSTANT_RESTARTS || 3) || 3,
);
let daemonRestartCount = 0;
const daemonCrashTracker = createDaemonCrashTracker({
  instantCrashWindowMs: DAEMON_INSTANT_CRASH_WINDOW_MS,
  maxInstantCrashes: DAEMON_MAX_INSTANT_RESTARTS,
});

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readAlivePid(pidFile) {
  try {
    if (!existsSync(pidFile)) return null;
    const raw = readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function parseBoolEnv(val, fallback = false) {
  if (val == null || String(val).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(val).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runSentinelCli(flag) {
  return await new Promise((resolveExit) => {
    const child = spawn(process.execPath, [SENTINEL_SCRIPT_PATH, flag], {
      stdio: "inherit",
      env: { ...process.env },
      cwd: process.cwd(),
    });
    child.on("error", () => resolveExit(1));
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

async function ensureSentinelRunning(options = {}) {
  const { quiet = false } = options;
  const existing =
    readAlivePid(SENTINEL_PID_FILE) || readAlivePid(SENTINEL_PID_FILE_LEGACY);
  if (existing) {
    if (!quiet) {
      console.log(`  telegram-sentinel already running (PID ${existing})`);
    }
    return { ok: true, pid: existing, alreadyRunning: true };
  }

  const child = spawn(process.execPath, [SENTINEL_SCRIPT_PATH], {
    detached: true,
    stdio: "ignore",
    windowsHide: process.platform === "win32",
    env: {
      ...process.env,
      OPENFLEET_SENTINEL_COMPANION: "1",
    },
    cwd: process.cwd(),
  });
  child.unref();

  const spawnedPid = child.pid;
  if (!spawnedPid) {
    return { ok: false, error: "sentinel spawn returned no PID" };
  }

  const timeoutAt = Date.now() + 5000;
  while (Date.now() < timeoutAt) {
    await sleep(200);
    const pid =
      readAlivePid(SENTINEL_PID_FILE) || readAlivePid(SENTINEL_PID_FILE_LEGACY);
    if (pid) {
      if (!quiet) {
        console.log(`  telegram-sentinel started (PID ${pid})`);
      }
      return { ok: true, pid, alreadyRunning: false };
    }
    if (!isProcessAlive(spawnedPid)) {
      return {
        ok: false,
        error: "telegram-sentinel exited during startup",
      };
    }
  }

  return {
    ok: false,
    error: "timed out waiting for telegram-sentinel to become healthy",
  };
}

function getDaemonPid() {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function writePidFile(pid) {
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, String(pid), "utf8");
  } catch {
    /* best effort */
  }
}

function removePidFile() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    /* ok */
  }
}

function startDaemon() {
  const existing = getDaemonPid();
  if (existing) {
    console.log(`  openfleet daemon is already running (PID ${existing})`);
    console.log(`  Use --stop-daemon to stop it first.`);
    process.exit(1);
  }

  // Ensure log directory exists
  try {
    mkdirSync(dirname(DAEMON_LOG), { recursive: true });
  } catch {
    /* ok */
  }

  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=4096",
      fileURLToPath(new URL("./cli.mjs", import.meta.url)),
      ...process.argv.slice(2).filter((a) => a !== "--daemon" && a !== "-d"),
      "--daemon-child",
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      env: { ...process.env, OPENFLEET_DAEMON: "1" },
      cwd: process.cwd(),
    },
  );

  child.unref();
  writePidFile(child.pid);

  console.log(`
  ╭──────────────────────────────────────────────────────────╮
  │ openfleet daemon started (PID ${String(child.pid).padEnd(24)}│
  ╰──────────────────────────────────────────────────────────╯

  Logs: ${DAEMON_LOG}
  PID:  ${PID_FILE}

  Commands:
    openfleet --daemon-status   Check if running
    openfleet --stop-daemon     Stop the daemon
  `);
  process.exit(0);
}

function stopDaemon() {
  const pid = getDaemonPid();
  if (!pid) {
    console.log("  No daemon running (PID file not found or process dead).");
    removePidFile();
    process.exit(0);
  }
  console.log(`  Stopping openfleet daemon (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
    // Wait briefly for graceful shutdown
    let tries = 0;
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch {
        removePidFile();
        console.log("  ✓ Daemon stopped.");
        process.exit(0);
      }
      if (++tries > 10) {
        console.log("  Sending SIGKILL...");
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ok */
        }
        removePidFile();
        console.log("  ✓ Daemon killed.");
        process.exit(0);
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 500);
  } catch (err) {
    console.error(`  Failed to stop daemon: ${err.message}`);
    removePidFile();
    process.exit(1);
  }
}

function daemonStatus() {
  const pid = getDaemonPid();
  if (pid) {
    console.log(`  openfleet daemon is running (PID ${pid})`);
  } else {
    console.log("  openfleet daemon is not running.");
    removePidFile();
  }
  process.exit(0);
}

async function main() {
  // Apply legacy CODEX_MONITOR_* → OPENFLEET_* env aliases before any config ops
  applyAllCompatibility();

  // Handle --help
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`openfleet v${VERSION}`);
    process.exit(0);
  }

  // Handle --doctor
  if (args.includes("--doctor") || args.includes("doctor")) {
    const { runConfigDoctor, formatConfigDoctorReport } =
      await import("./config-doctor.mjs");
    const result = runConfigDoctor();
    console.log(formatConfigDoctorReport(result));
    process.exit(result.ok ? 0 : 1);
  }

  // Handle sentinel controls
  if (args.includes("--sentinel-stop")) {
    process.exit(await runSentinelCli("--stop"));
  }
  if (args.includes("--sentinel-status")) {
    process.exit(await runSentinelCli("--status"));
  }

  // Handle --daemon
  if (args.includes("--daemon") || args.includes("-d")) {
    const { shouldRunSetup, runSetup } = await import("./setup.mjs");
    if (shouldRunSetup()) {
      console.log(
        "\n  🚀 First run detected — setup is required before daemon mode.\n",
      );
      await runSetup();
      console.log("\n  Setup complete. Starting daemon...\n");
    }
    startDaemon();
    return;
  }
  if (args.includes("--stop-daemon")) {
    stopDaemon();
    return;
  }
  if (args.includes("--daemon-status")) {
    daemonStatus();
    return;
  }

  // Write PID file if running as daemon child
  if (
    args.includes("--daemon-child") ||
    process.env.OPENFLEET_DAEMON === "1"
  ) {
    writePidFile(process.pid);
    // Redirect console to log file on daemon child
    const { createWriteStream } = await import("node:fs");
    const logStream = createWriteStream(DAEMON_LOG, { flags: "a" });
    let logStreamErrored = false;
    logStream.on("error", () => {
      logStreamErrored = true;
    });
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    const safeWrite = (writeFn, chunk, args) => {
      try {
        return writeFn(chunk, ...args);
      } catch (err) {
        if (
          err &&
          (err.code === "EPIPE" ||
            err.code === "ERR_STREAM_DESTROYED" ||
            err.code === "ERR_STREAM_WRITE_AFTER_END")
        ) {
          return false;
        }
        throw err;
      }
    };
    process.stdout.write = (chunk, ...a) => {
      if (!logStreamErrored) {
        safeWrite(logStream.write.bind(logStream), chunk, []);
      }
      return safeWrite(origStdout, chunk, a);
    };
    process.stderr.write = (chunk, ...a) => {
      if (!logStreamErrored) {
        safeWrite(logStream.write.bind(logStream), chunk, []);
      }
      return safeWrite(origStderr, chunk, a);
    };
    console.log(
      `\n[daemon] openfleet started at ${new Date().toISOString()} (PID ${process.pid})`,
    );
  }

  const sentinelRequested =
    args.includes("--sentinel") ||
    parseBoolEnv(process.env.OPENFLEET_SENTINEL_AUTO_START, false);
  if (sentinelRequested) {
    const sentinel = await ensureSentinelRunning({ quiet: false });
    if (!sentinel.ok) {
      const mode = args.includes("--sentinel")
        ? "requested by --sentinel"
        : "requested by OPENFLEET_SENTINEL_AUTO_START";
      const strictSentinel = parseBoolEnv(
        process.env.OPENFLEET_SENTINEL_STRICT,
        false,
      );
      const prefix = strictSentinel ? "✖" : "⚠";
      const suffix = strictSentinel
        ? ""
        : " (continuing without sentinel companion)";
      console.error(
        `  ${prefix} Failed to start telegram-sentinel (${mode}): ${sentinel.error}${suffix}`,
      );
      if (strictSentinel) {
        process.exit(1);
      }
    }
  }

  // Handle --enable-startup / --disable-startup / --startup-status
  if (args.includes("--enable-startup")) {
    const { installStartupService, getStartupMethodName } =
      await import("./startup-service.mjs");
    const result = await installStartupService({ daemon: true });
    if (result.success) {
      console.log(`  \u2705 Startup service installed via ${result.method}`);
      if (result.path) console.log(`     Path: ${result.path}`);
      if (result.name) console.log(`     Name: ${result.name}`);
      console.log(`\n  openfleet will auto-start on login.`);
    } else {
      console.error(
        `  \u274c Failed to install startup service: ${result.error}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes("--disable-startup")) {
    const { removeStartupService } = await import("./startup-service.mjs");
    const result = await removeStartupService();
    if (result.success) {
      console.log(`  \u2705 Startup service removed (${result.method})`);
    } else {
      console.error(
        `  \u274c Failed to remove startup service: ${result.error}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes("--startup-status")) {
    const { getStartupStatus } = await import("./startup-service.mjs");
    const status = getStartupStatus();
    if (status.installed) {
      console.log(`  Startup service: installed (${status.method})`);
      if (status.name) console.log(`  Name: ${status.name}`);
      if (status.path) console.log(`  Path: ${status.path}`);
      if (status.running !== undefined)
        console.log(`  Running: ${status.running ? "yes" : "no"}`);
    } else {
      console.log(`  Startup service: not installed`);
      console.log(`  Run 'openfleet --enable-startup' to register.`);
    }
    process.exit(0);
  }

  // Handle --update (force update)
  if (args.includes("--update")) {
    const { forceUpdate } = await import("./update-check.mjs");
    await forceUpdate(VERSION);
    process.exit(0);
  }

  // ── Startup banner with update check ──────────────────────────────────────
  console.log("");
  console.log("  ╭──────────────────────────────────────────────────────────╮");
  console.log(
    `  │ >_ openfleet (v${VERSION})${" ".repeat(Math.max(0, 39 - VERSION.length))}│`,
  );
  console.log("  ╰──────────────────────────────────────────────────────────╯");

  // Non-blocking update check (don't delay startup)
  if (!args.includes("--no-update-check")) {
    import("./update-check.mjs")
      .then(({ checkForUpdate }) => checkForUpdate(VERSION))
      .catch(() => {}); // silent — never block startup
  }

  // Propagate --no-auto-update to env for monitor.mjs to pick up
  if (args.includes("--no-auto-update")) {
    process.env.OPENFLEET_SKIP_AUTO_UPDATE = "1";
  }

  // Mark all child processes as openfleet managed.
  // The agent-hook-bridge checks this to avoid firing hooks for standalone
  // agent sessions that happen to have hook config files in their tree.
  process.env.VE_MANAGED = "1";

  // Handle --setup
  if (args.includes("--setup") || args.includes("setup")) {
    const configDirArg = getArgValue("--config-dir");
    if (configDirArg) {
      process.env.OPENFLEET_DIR = configDirArg;
    }
    const { runSetup } = await import("./setup.mjs");
    await runSetup();
    process.exit(0);
  }

  // Handle --whatsapp-auth
  if (args.includes("--whatsapp-auth") || args.includes("whatsapp-auth")) {
    const mode = args.includes("--pairing-code") ? "pairing-code" : "qr";
    const { runWhatsAppAuth } = await import("./whatsapp-channel.mjs");
    await runWhatsAppAuth(mode);
    process.exit(0);
  }

  // First-run detection
  const { shouldRunSetup } = await import("./setup.mjs");
  if (shouldRunSetup()) {
    console.log("\n  🚀 First run detected — launching setup wizard...\n");
    const configDirArg = getArgValue("--config-dir");
    if (configDirArg) {
      process.env.OPENFLEET_DIR = configDirArg;
    }
    const { runSetup } = await import("./setup.mjs");
    await runSetup();
    console.log("\n  Setup complete! Starting openfleet...\n");
  }

  // Legacy migration: if ~/codex-monitor exists with config, auto-migrate to ~/openfleet
  const legacyInfo = detectLegacySetup();
  if (legacyInfo.hasLegacy && !legacyInfo.alreadyMigrated) {
    console.log(
      `\n  📦 Detected legacy codex-monitor config at ${legacyInfo.legacyDir}`,
    );
    console.log(`     Auto-migrating to ${legacyInfo.newDir}...\n`);
    const result = migrateFromLegacy(legacyInfo.legacyDir, legacyInfo.newDir);
    if (result.migrated.length > 0) {
      console.log(`  ✅  Migrated: ${result.migrated.join(", ")}`);
      console.log(`\n  Config is now at ${legacyInfo.newDir}\n`);
    }
    for (const err of result.errors) {
      console.log(`  ⚠️   Migration warning: ${err}`);
    }
  }

  // ── Handle --echo-logs: tail the active monitor's log instead of spawning a new instance ──
  if (args.includes("--echo-logs")) {
    // Search for the monitor PID file in common cache locations
    const candidatePidFiles = [
      process.env.OPENFLEET_DIR
        ? resolve(process.env.OPENFLEET_DIR, ".cache", "openfleet.pid")
        : null,
      resolve(__dirname, "..", ".cache", "openfleet.pid"),
      resolve(process.cwd(), ".cache", "openfleet.pid"),
    ].filter(Boolean);

    let activePidFile = null;
    for (const f of candidatePidFiles) {
      if (existsSync(f)) {
        activePidFile = f;
        break;
      }
    }

    if (activePidFile) {
      try {
        const pidData = JSON.parse(readFileSync(activePidFile, "utf8"));
        const monitorPid = Number(pidData.pid);
        const monitorPath = (pidData.argv || [])[1] || "";

        let isAlive = false;
        try {
          process.kill(monitorPid, 0);
          isAlive = true;
        } catch {}

        if (isAlive && monitorPath) {
          const logDir = resolve(dirname(monitorPath), "logs");
          const daemonLog = resolve(logDir, "daemon.log");
          const monitorLog = resolve(logDir, "monitor.log");
          const logFile = existsSync(daemonLog) ? daemonLog : monitorLog;

          if (existsSync(logFile)) {
            console.log(
              `\n  Tailing logs for active openfleet (PID ${monitorPid}):\n  ${logFile}\n`,
            );
            await new Promise((res) => {
              // Spawn tail in its own process group (detached) so that
              // Ctrl+C in this terminal only kills the tailing session,
              // never the running daemon.
              const tail = spawn("tail", ["-f", "-n", "200", logFile], {
                stdio: ["ignore", "inherit", "inherit"],
                detached: true,
              });
              tail.on("exit", res);
              process.on("SIGINT", () => {
                try { process.kill(-tail.pid, "SIGTERM"); } catch { tail.kill(); }
                res();
              });
            });
            process.exit(0);
          } else {
            console.error(
              `\n  No log file found for active openfleet (PID ${monitorPid}).\n  Expected: ${logFile}\n`,
            );
            process.exit(1);
          }
        }
      } catch (e) {
        console.error(`\n  --echo-logs: failed to read PID file — ${e.message}\n`);
        process.exit(1);
      }
    } else {
      console.error(
        "\n  --echo-logs: no active openfleet found (PID file missing).\n  Start openfleet first with: openfleet --daemon\n",
      );
      process.exit(1);
    }

    // Should not reach here — all paths above exit
    process.exit(0);
  }

  // Fork monitor as a child process — enables self-restart on source changes.
  // When monitor exits with code 75, cli re-forks with a fresh ESM module cache.
  await runMonitor();
}

// ── Crash notification (last resort — raw fetch when monitor can't start) ─────

function readEnvCredentials() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (
        key === "TELEGRAM_BOT_TOKEN" ||
        key === "TELEGRAM_CHAT_ID" ||
        key === "PROJECT_NAME"
      ) {
        vars[key] = val;
      }
    }
  } catch {
    // best effort
  }
  return vars;
}

async function sendCrashNotification(exitCode, signal, options = {}) {
  const { autoRestartInMs = 0, restartAttempt = 0, maxRestarts = 0 } = options;
  const env = readEnvCredentials();
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const project = env.PROJECT_NAME || process.env.PROJECT_NAME || "";
  const host = os.hostname();
  const tag = project ? `[${project}]` : "";
  const reason = signal ? `signal ${signal}` : `exit code ${exitCode}`;
  const isAutoRestart = Number(autoRestartInMs) > 0;
  const restartLine = isAutoRestart
    ? [
        `Auto-restart scheduled in ${Math.max(1, Math.round(autoRestartInMs / 1000))}s.`,
        restartAttempt > 0
          ? `Restart attempt: ${restartAttempt}${maxRestarts > 0 ? `/${maxRestarts}` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "Monitor is no longer running. Manual restart required.";
  const text =
    `🔥 *CRASH* ${tag} openfleet v${VERSION} died unexpectedly\n` +
    `Host: \`${host}\`\n` +
    `Reason: \`${reason}\`\n` +
    `Time: ${new Date().toISOString()}\n\n` +
    restartLine;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort — if Telegram is unreachable, nothing we can do
  }
}

// ── Self-restart exit code (must match monitor.mjs SELF_RESTART_EXIT_CODE) ───
const SELF_RESTART_EXIT_CODE = 75;
let monitorChild = null;

function runMonitor() {
  return new Promise((resolve, reject) => {
    const monitorPath = fileURLToPath(
      new URL("./monitor.mjs", import.meta.url),
    );
    monitorChild = fork(monitorPath, process.argv.slice(2), {
      stdio: "inherit",
      execArgv: ["--max-old-space-size=4096"],
      windowsHide: IS_DAEMON_CHILD && process.platform === "win32",
    });
    daemonCrashTracker.markStart();

    monitorChild.on("exit", (code, signal) => {
      monitorChild = null;
      if (code === SELF_RESTART_EXIT_CODE) {
        console.log(
          "\n  \u21BB Monitor source changed \u2014 restarting with fresh modules...\n",
        );
        // Small delay to let file writes settle
        setTimeout(() => resolve(runMonitor()), 1000);
      } else {
        const exitCode = code ?? (signal ? 1 : 0);
        // 4294967295 (0xFFFFFFFF / -1 signed) = OS killed the process (OOM, external termination)
        const isOSKill = exitCode === 4294967295 || exitCode === -1;
        const shouldAutoRestart =
          !gracefulShutdown &&
          (isOSKill || (IS_DAEMON_CHILD && exitCode !== 0));
        if (shouldAutoRestart) {
          const crashState = daemonCrashTracker.recordExit();
          daemonRestartCount += 1;
          const delayMs = isOSKill ? 5000 : DAEMON_RESTART_DELAY_MS;
          if (IS_DAEMON_CHILD && crashState.exceeded) {
            const durationSec = Math.max(
              1,
              Math.round(crashState.runDurationMs / 1000),
            );
            const windowSec = Math.max(
              1,
              Math.round(crashState.instantCrashWindowMs / 1000),
            );
            console.error(
              `\n  ✖ Monitor crashed too quickly ${crashState.instantCrashCount} times in a row (each <= ${windowSec}s, latest ${durationSec}s). Auto-restart is now paused.`,
            );
            sendCrashNotification(exitCode, signal).finally(() =>
              process.exit(exitCode),
            );
            return;
          }
          if (
            IS_DAEMON_CHILD &&
            DAEMON_MAX_RESTARTS > 0 &&
            daemonRestartCount > DAEMON_MAX_RESTARTS
          ) {
            console.error(
              `\n  ✖ Monitor crashed too many times (${daemonRestartCount - 1} restarts, max ${DAEMON_MAX_RESTARTS}).`,
            );
            sendCrashNotification(exitCode, signal).finally(() =>
              process.exit(exitCode),
            );
            return;
          }
          const reasonLabel = signal
            ? `signal ${signal}`
            : `exit code ${exitCode}`;
          const attemptLabel =
            IS_DAEMON_CHILD && DAEMON_MAX_RESTARTS > 0
              ? `${daemonRestartCount}/${DAEMON_MAX_RESTARTS}`
              : `${daemonRestartCount}`;
          console.error(
            `\n  ⚠ Monitor exited (${reasonLabel}) — auto-restarting in ${Math.max(1, Math.round(delayMs / 1000))}s${IS_DAEMON_CHILD ? ` [attempt ${attemptLabel}]` : ""}...`,
          );
          sendCrashNotification(exitCode, signal, {
            autoRestartInMs: delayMs,
            restartAttempt: daemonRestartCount,
            maxRestarts: IS_DAEMON_CHILD ? DAEMON_MAX_RESTARTS : 0,
          }).catch(() => {});
          setTimeout(() => resolve(runMonitor()), delayMs);
          return;
        }

        if (exitCode !== 0 && !gracefulShutdown) {
          console.error(
            `\n  ✖ Monitor crashed (${signal ? `signal ${signal}` : `exit code ${exitCode}`}) — sending crash notification...`,
          );
          sendCrashNotification(exitCode, signal).finally(() =>
            process.exit(exitCode),
          );
        } else {
          daemonRestartCount = 0;
          daemonCrashTracker.reset();
          process.exit(exitCode);
        }
      }
    });

    monitorChild.on("error", (err) => {
      monitorChild = null;
      console.error(`\n  ✖ Monitor failed to start: ${err.message}`);
      sendCrashNotification(1, null).finally(() => reject(err));
    });
  });
}

// Let forked monitor handle signal cleanup — prevent parent from dying first
let gracefulShutdown = false;
process.on("SIGINT", () => {
  gracefulShutdown = true;
  if (!monitorChild) process.exit(0);
  // Child gets SIGINT too via shared terminal — just wait for it to exit
});
process.on("SIGTERM", () => {
  gracefulShutdown = true;
  if (!monitorChild) process.exit(0);
  try {
    monitorChild.kill("SIGTERM");
  } catch {
    /* best effort */
  }
});

main().catch(async (err) => {
  console.error(`openfleet failed: ${err.message}`);
  await sendCrashNotification(1, null).catch(() => {});
  process.exit(1);
});
