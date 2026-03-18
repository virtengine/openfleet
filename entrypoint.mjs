#!/usr/bin/env node

/**
 * entrypoint.mjs — Unified Bosun entrypoint for Docker, Desktop, and CLI.
 *
 * This is the single process owner for all Bosun child processes.
 * It starts the unified UI server (which includes setup wizard if needed),
 * spawns the monitor loop as a managed child, handles SIGTERM/SIGINT
 * gracefully, and provides a /healthz endpoint.
 *
 * Environment detection:
 *   BOSUN_DOCKER=1   → container mode (bind 0.0.0.0, logs to stdout, tini as PID 1)
 *   BOSUN_DESKTOP=1  → Electron mode (bind 127.0.0.1, auto-open browser)
 *   (neither)        → bare CLI mode
 *
 * Usage:
 *   node entrypoint.mjs                    # default start
 *   BOSUN_DOCKER=1 node entrypoint.mjs     # Docker container
 *   BOSUN_DESKTOP=1 node entrypoint.mjs    # Desktop app
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TAG = "[entrypoint]";
const isDocker = process.env.BOSUN_DOCKER === "1";
const isDesktop = process.env.BOSUN_DESKTOP === "1";

// ── Data directory resolution ───────────────────────────────────────────────
// In Docker: /data (volume mount)
// Otherwise: respect BOSUN_HOME / BOSUN_DIR, or let config.mjs resolve
function resolveDataDir() {
  if (isDocker) {
    const dataDir = process.env.BOSUN_HOME || "/data";
    process.env.BOSUN_HOME = dataDir;
    process.env.BOSUN_DIR = dataDir;
    return dataDir;
  }
  return process.env.BOSUN_HOME || process.env.BOSUN_DIR || "";
}

// ── Child process management ────────────────────────────────────────────────

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const children = new Map();

/** @type {boolean} */
let shuttingDown = false;

/** @type {number} */
const startedAt = Date.now();

/** @type {{ monitor: string, server: string }} */
const componentStatus = {
  monitor: "stopped",
  server: "stopped",
};

/** @type {boolean} */
let setupComplete = false;

// Track monitor crash history for circuit breaker
const monitorCrashTimestamps = [];
const MONITOR_CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const MONITOR_CIRCUIT_BREAKER_MAX_CRASHES = 3;
let monitorCircuitBroken = false;

/**
 * Spawn a managed child process.
 * @param {string} name - Human label for logs
 * @param {string} script - Path to the script to run
 * @param {string[]} args - Arguments
 * @param {object} [opts] - spawn options overrides
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnChild(name, script, args = [], opts = {}) {
  if (shuttingDown) return null;

  const child = spawn(process.execPath, [script, ...args], {
    cwd: opts.cwd || __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });

  children.set(name, child);
  componentStatus[name] = "running";

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    children.delete(name);
    componentStatus[name] = "stopped";

    if (shuttingDown) {
      console.log(`${TAG} ${name} exited (shutdown)`);
      return;
    }

    console.warn(`${TAG} ${name} exited (code=${code} signal=${signal})`);

    // Self-restart exit code (75) means monitor wants a clean re-fork
    if (name === "monitor" && code === 75) {
      console.log(`${TAG} monitor requested restart (exit code 75)`);
      startMonitor();
      return;
    }

    // Circuit breaker for monitor crashes
    if (name === "monitor") {
      const now = Date.now();
      monitorCrashTimestamps.push(now);
      // Trim old entries outside window
      while (
        monitorCrashTimestamps.length > 0 &&
        now - monitorCrashTimestamps[0] > MONITOR_CIRCUIT_BREAKER_WINDOW_MS
      ) {
        monitorCrashTimestamps.shift();
      }
      if (monitorCrashTimestamps.length >= MONITOR_CIRCUIT_BREAKER_MAX_CRASHES) {
        monitorCircuitBroken = true;
        console.error(
          `${TAG} monitor circuit breaker tripped: ${monitorCrashTimestamps.length} crashes in ${MONITOR_CIRCUIT_BREAKER_WINDOW_MS / 1000}s — stopping restarts`,
        );
        return;
      }

      // Restart with backoff
      const delay = Math.min(5000 * monitorCrashTimestamps.length, 30_000);
      console.log(`${TAG} restarting monitor in ${delay}ms`);
      setTimeout(() => startMonitor(), delay);
    }
  });

  child.on("error", (err) => {
    console.error(`${TAG} ${name} spawn error: ${err.message}`);
    children.delete(name);
    componentStatus[name] = "error";
  });

  return child;
}

// ── Monitor lifecycle ───────────────────────────────────────────────────────

function startMonitor() {
  if (shuttingDown || monitorCircuitBroken) return;
  if (children.has("monitor")) return;

  const monitorScript = resolve(__dirname, "infra", "monitor.mjs");
  if (!existsSync(monitorScript)) {
    console.error(`${TAG} monitor script not found: ${monitorScript}`);
    componentStatus.monitor = "error";
    return;
  }

  const monitorArgs = [];
  // Pass through relevant CLI args
  if (process.env.BOSUN_DIR) {
    monitorArgs.push("--config-dir", process.env.BOSUN_DIR);
  }

  console.log(`${TAG} starting monitor`);
  spawnChild("monitor", monitorScript, monitorArgs);
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${TAG} ${signal} received — shutting down`);

  // Send SIGTERM to all children
  for (const [name, child] of children.entries()) {
    console.log(`${TAG} sending SIGTERM to ${name} (pid=${child.pid})`);
    try {
      child.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }

  // Wait for children to exit, with a hard timeout
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (children.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // SIGKILL any stragglers
  for (const [name, child] of children.entries()) {
    console.warn(`${TAG} force-killing ${name} (pid=${child.pid})`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Windows: ensure cleanup on exit
process.on("exit", () => {
  for (const [, child] of children.entries()) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }
});

// ── Health endpoint ─────────────────────────────────────────────────────────

/**
 * Returns current health status object.
 * @returns {object}
 */
export function getHealthStatus() {
  return {
    status: shuttingDown ? "shutting_down" : monitorCircuitBroken ? "degraded" : "ok",
    setup: setupComplete,
    monitor: componentStatus.monitor,
    server: componentStatus.server,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    docker: isDocker,
    desktop: isDesktop,
  };
}

/**
 * Mark setup as complete (called from ui-server when setup finishes).
 */
export function markSetupComplete() {
  const wasSetupComplete = setupComplete;
  setupComplete = true;

  // If we just transitioned from "not complete" to "complete", and the process
  // is still running, ensure the monitor is started when not already running.
  if (!wasSetupComplete && !shuttingDown && !children.has("monitor")) {
    try {
      startMonitor();
    } catch (err) {
      // Log but do not crash if automatic monitor start fails
      console.error(
        `${TAG} failed to start monitor after setup completion: ${
          err && err.message ? err.message : err
        }`,
      );
    }
  }
}

// ── Main startup ────────────────────────────────────────────────────────────

async function main() {
  const dataDir = resolveDataDir();

  console.log(`${TAG} starting bosun`);
  console.log(`${TAG} mode: ${isDocker ? "docker" : isDesktop ? "desktop" : "cli"}`);
  if (dataDir) {
    console.log(`${TAG} data dir: ${dataDir}`);
    // Ensure data directory exists
    mkdirSync(dataDir, { recursive: true });
  }

  // ── Check if setup is needed ──────────────────────────────────────────
  try {
    const { shouldRunSetup } = await import("./setup.mjs");
    setupComplete = !shouldRunSetup();
  } catch {
    // If setup.mjs fails to load, assume setup is needed
    setupComplete = false;
  }

  // ── Start the unified UI server ───────────────────────────────────────
  // The ui-server now handles both /setup (wizard) and / (portal)
  try {
    const { startTelegramUiServer } = await import("./server/ui-server.mjs");

    const host = isDocker ? "0.0.0.0" : isDesktop ? "127.0.0.1" : undefined;
    const port = Number(process.env.BOSUN_PORT || process.env.PORT || process.env.TELEGRAM_UI_PORT || "") || 3080;

    const server = await startTelegramUiServer({
      host,
      port,
      // Pass setup state so ui-server knows whether to redirect to /setup
      setupMode: !setupComplete,
    });

    if (server) {
      componentStatus.server = "running";
      console.log(`${TAG} ui server started`);
    } else {
      console.warn(`${TAG} ui server returned null — may be a duplicate instance`);
      componentStatus.server = "error";
    }
  } catch (err) {
    console.error(`${TAG} failed to start ui server: ${err.message}`);
    componentStatus.server = "error";
  }

  // ── Start monitor (only if setup is complete) ─────────────────────────
  if (setupComplete) {
    startMonitor();
  } else {
    console.log(`${TAG} setup not complete — monitor will start after setup finishes`);
  }

  // In Docker mode, log to stdout that we're ready
  if (isDocker) {
    console.log(`${TAG} container ready`);
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(`${TAG} fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}
