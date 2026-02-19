/**
 * update-check.mjs — Self-updating system for openfleet.
 *
 * Capabilities:
 *   - `checkForUpdate(currentVersion)` — non-blocking startup check, prints notice
 *   - `forceUpdate(currentVersion)` — interactive `npm install -g` with confirmation
 *   - `startAutoUpdateLoop(opts)` — background polling loop (default 10 min) that
 *       auto-installs updates and restarts the process. Zero user interaction.
 *
 * Respects:
 *   - OPENFLEET_SKIP_UPDATE_CHECK=1 — disable startup check
 *   - OPENFLEET_SKIP_AUTO_UPDATE=1 — disable polling auto-update
 *   - OPENFLEET_UPDATE_INTERVAL_MS — override poll interval (default 10 min)
 *   - Caches the last check timestamp so we don't query npm too aggressively
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "@virtengine/openfleet";
const CACHE_FILE = resolve(__dirname, "logs", ".update-check-cache.json");
const STARTUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (startup notice)
const AUTO_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes (polling loop)

function runNpmCommand(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return execFileSync(process.execPath, [npmExecPath, ...args], options);
  }

  const nodeBinDir = dirname(process.execPath);
  const candidates =
    process.platform === "win32"
      ? [
          join(nodeBinDir, "npm.cmd"),
          join(nodeBinDir, "npm.exe"),
          join(nodeBinDir, "npm"),
        ]
      : [join(nodeBinDir, "npm")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return execFileSync(candidate, args, options);
    }
  }

  const fallback = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(fallback, args, options);
}

// ── Semver comparison ────────────────────────────────────────────────────────

function parseVersion(v) {
  const parts = v.replace(/^v/, "").split(".").map(Number);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  return r.patch > l.patch;
}

// ── Cache ────────────────────────────────────────────────────────────────────

async function readCache() {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeCache(data) {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch {
    // non-critical
  }
}

// ── Registry query ───────────────────────────────────────────────────────────

async function fetchLatestVersion() {
  // Try native fetch (Node 18+), fall back to npm view
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.version || null;
    }
  } catch {
    // fetch failed, try npm view
  }

  try {
    const out = runNpmCommand(["view", PKG_NAME, "version"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Non-blocking update check. Prints a notice if an update is available.
 * Called on startup — must never throw or delay the main process.
 */
export async function checkForUpdate(currentVersion) {
  if (process.env.OPENFLEET_SKIP_UPDATE_CHECK) return;

  try {
    // Rate-limit: at most once per hour
    const cache = await readCache();
    const now = Date.now();
    if (cache.lastCheck && now - cache.lastCheck < STARTUP_CHECK_INTERVAL_MS) {
      // Use cached result if still fresh
      if (cache.latestVersion && isNewer(cache.latestVersion, currentVersion)) {
        printUpdateNotice(currentVersion, cache.latestVersion);
      }
      return;
    }

    const latest = await fetchLatestVersion();
    await writeCache({ lastCheck: now, latestVersion: latest });

    if (latest && isNewer(latest, currentVersion)) {
      printUpdateNotice(currentVersion, latest);
    }
  } catch {
    // Silent — never interfere with startup
  }
}

/**
 * Force-update to the latest version.
 * Prompts for confirmation, then runs npm install -g.
 */
export async function forceUpdate(currentVersion) {
  console.log(`\n  Current version: v${currentVersion}`);
  console.log("  Checking npm registry...\n");

  const latest = await fetchLatestVersion();

  if (!latest) {
    console.log("  ❌ Could not reach npm registry. Check your connection.\n");
    return;
  }

  if (!isNewer(latest, currentVersion)) {
    console.log(`  ✅ Already up to date (v${currentVersion})\n`);
    return;
  }

  console.log(`  📦 Update available: v${currentVersion} → v${latest}\n`);

  const confirmed = await promptConfirm("  Install update now? [Y/n]: ");

  if (!confirmed) {
    console.log("  Skipped.\n");
    return;
  }

  console.log(`\n  Installing ${PKG_NAME}@${latest}...\n`);

  try {
    runNpmCommand(["install", "-g", `${PKG_NAME}@${latest}`], {
      stdio: "inherit",
      timeout: 120000,
    });
    console.log(
      `\n  ✅ Updated to v${latest}. Restart openfleet to use the new version.\n`,
    );
  } catch (err) {
    console.error(`\n  ❌ Update failed: ${err.message}`);
    console.error(`  Try manually: npm install -g ${PKG_NAME}@latest\n`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the current version from package.json (on-disk, not cached import).
 * After an auto-update, the on-disk package.json reflects the new version.
 */
export function getCurrentVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Auto-update polling loop ─────────────────────────────────────────────────

let autoUpdateTimer = null;
let autoUpdateRunning = false;
let parentPid = null;
let parentCheckInterval = null;
let cleanupHandlersRegistered = false;

/**
 * Start a background polling loop that checks for updates every `intervalMs`
 * (default 10 min). When a newer version is found, it:
 *   1. Runs `npm install -g @virtengine/openfleet@<version>`
 *   2. Calls `onRestart()` (or `process.exit(0)` if not provided)
 *
 * This is fully autonomous — no user interaction required.
 *
 * Safety features to prevent zombie processes:
 *   - Monitors parent process health (terminates if parent dies)
 *   - Registers cleanup handlers for SIGTERM, SIGINT, SIGHUP
 *   - Cleans up intervals on process exit or uncaught exceptions
 *   - Periodic parent health check every 30 seconds
 *
 * @param {object} opts
 * @param {function} [opts.onRestart] - Called after successful update (should restart process)
 * @param {function} [opts.onNotify]  - Called with message string for Telegram/log
 * @param {number}   [opts.intervalMs] - Poll interval (default: 10 min)
 * @param {number}   [opts.parentPid]  - Parent process PID to monitor (default: process.ppid)
 */
export function startAutoUpdateLoop(opts = {}) {
  if (process.env.OPENFLEET_SKIP_AUTO_UPDATE === "1") {
    console.log("[auto-update] Disabled via OPENFLEET_SKIP_AUTO_UPDATE=1");
    return;
  }

  const intervalMs =
    Number(process.env.OPENFLEET_UPDATE_INTERVAL_MS) ||
    opts.intervalMs ||
    AUTO_UPDATE_INTERVAL_MS;
  const onRestart = opts.onRestart || (() => process.exit(0));
  const onNotify = opts.onNotify || ((msg) => console.log(msg));

  // Register cleanup handlers to prevent zombie processes
  registerCleanupHandlers();

  // Track parent process if provided
  if (opts.parentPid) {
    parentPid = opts.parentPid;
    console.log(`[auto-update] Monitoring parent process PID ${parentPid}`);
  } else {
    parentPid = process.ppid; // Track parent by default
    console.log(`[auto-update] Monitoring parent process PID ${parentPid}`);
  }

  console.log(
    `[auto-update] Polling every ${Math.round(intervalMs / 1000 / 60)} min for upstream changes`,
  );

  async function poll() {
    // Safety check: Is parent process still alive?
    if (!isParentAlive()) {
      console.log(
        `[auto-update] Parent process ${parentPid} no longer exists. Terminating.`,
      );
      stopAutoUpdateLoop();
      process.exit(0);
    }

    if (autoUpdateRunning) return;
    autoUpdateRunning = true;
    try {
      const currentVersion = getCurrentVersion();
      const latest = await fetchLatestVersion();

      if (!latest) {
        autoUpdateRunning = false;
        return; // registry unreachable — try again next cycle
      }

      if (!isNewer(latest, currentVersion)) {
        autoUpdateRunning = false;
        return; // already up to date
      }

      // ── Update detected! ──────────────────────────────────────────────
      const msg = `[auto-update] 🔄 Update detected: v${currentVersion} → v${latest}. Installing...`;
      console.log(msg);
      onNotify(msg);

      try {
        runNpmCommand(["install", "-g", `${PKG_NAME}@${latest}`], {
          timeout: 180000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (installErr) {
        const errMsg = `[auto-update] ❌ Install failed: ${installErr.message || installErr}`;
        console.error(errMsg);
        onNotify(errMsg);
        autoUpdateRunning = false;
        return;
      }

      // Verify the install actually changed the on-disk version
      const newVersion = getCurrentVersion();
      if (!isNewer(newVersion, currentVersion) && newVersion !== latest) {
        const errMsg = `[auto-update] ⚠️ Install ran but version unchanged (${newVersion}). Skipping restart.`;
        console.warn(errMsg);
        onNotify(errMsg);
        autoUpdateRunning = false;
        return;
      }

      await writeCache({ lastCheck: Date.now(), latestVersion: latest });

      const successMsg = `[auto-update] ✅ Updated to v${latest}. Restarting...`;
      console.log(successMsg);
      onNotify(successMsg);

      // Give Telegram a moment to deliver the notification
      await new Promise((r) => setTimeout(r, 2000));

      onRestart(`auto-update v${currentVersion} → v${latest}`);
    } catch (err) {
      console.warn(`[auto-update] Poll error: ${err.message || err}`);
    } finally {
      autoUpdateRunning = false;
    }
  }

  // Set up parent health check (every 30s)
  if (parentPid) {
    parentCheckInterval = setInterval(() => {
      if (!isParentAlive()) {
        console.log(`[auto-update] Parent process ${parentPid} died. Exiting.`);
        stopAutoUpdateLoop();
        process.exit(0);
      }
    }, 30 * 1000);
  }

  // First poll after 60s (let startup settle), then every intervalMs
  setTimeout(() => {
    void poll();
    autoUpdateTimer = setInterval(() => void poll(), intervalMs);
  }, 60 * 1000);
}

/**
 * Stop the auto-update polling loop (for clean shutdown).
 */
export function stopAutoUpdateLoop() {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
  if (parentCheckInterval) {
    clearInterval(parentCheckInterval);
    parentCheckInterval = null;
  }
  parentPid = null;
}

/**
 * Check if parent process is still alive.
 * If parent dies, this child polling loop should terminate too.
 */
function isParentAlive() {
  if (!parentPid) return true; // No parent tracking configured
  try {
    // On Windows and Unix, kill(pid, 0) checks if process exists without sending signal
    process.kill(parentPid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process
    if (err.code === "ESRCH") {
      return false;
    }
    // Other errors (EPERM) mean process exists but we can't signal it
    return true;
  }
}

/**
 * Register cleanup handlers to prevent zombie processes.
 */
function registerCleanupHandlers() {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;

  const cleanup = (signal) => {
    console.log(`[auto-update] Received ${signal}, cleaning up...`);
    stopAutoUpdateLoop();
    // Don't call process.exit() - let the signal handler chain continue
  };

  // Handle graceful shutdown signals
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));

  // Handle process exit
  process.on("exit", () => {
    stopAutoUpdateLoop();
  });

  // Handle uncaught exceptions (last resort)
  const originalUncaughtException = process.listeners("uncaughtException");
  process.on("uncaughtException", (err) => {
    console.error(`[auto-update] Uncaught exception, cleaning up:`, err);
    stopAutoUpdateLoop();
    // Re-emit for other handlers
    if (originalUncaughtException.length > 0) {
      for (const handler of originalUncaughtException) {
        handler(err);
      }
    }
  });
}

function printUpdateNotice(current, latest) {
  console.log("");
  console.log("  ╭──────────────────────────────────────────────────────────╮");
  console.log(
    `  │  Update available: v${current} → v${latest}${" ".repeat(Math.max(0, 38 - current.length - latest.length))}│`,
  );
  console.log("  │                                                          │");
  console.log(`  │  Run: npm install -g ${PKG_NAME}@latest      │`);
  console.log("  │  Or:  openfleet --update                             │");
  console.log("  ╰──────────────────────────────────────────────────────────╯");
  console.log("");
}

function promptConfirm(question) {
  return new Promise((res) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY && process.stdout.isTTY,
    });
    rl.question(question, (answer) => {
      try {
        rl.close();
      } catch (err) {
        const msg = err?.message || String(err || "");
        if (!msg.includes("setRawMode EIO")) {
          throw err;
        }
      }
      const a = answer.trim().toLowerCase();
      res(!a || a === "y" || a === "yes");
    });
  });
}
