/**
 * update-check.mjs — Self-updating system for bosun.
 *
 * Capabilities:
 *   - `checkForUpdate(currentVersion)` — non-blocking startup check, prints notice
 *   - `forceUpdate(currentVersion)` — interactive `npm install -g` with confirmation
 *   - `startAutoUpdateLoop(opts)` — background polling loop (default 10 min) that
 *       auto-installs updates and restarts the process. Zero user interaction.
 *
 * Respects:
 *   - BOSUN_SKIP_UPDATE_CHECK=1 — disable startup check
 *   - BOSUN_SKIP_AUTO_UPDATE=1 — disable polling auto-update
 *   - BOSUN_UPDATE_INTERVAL_MS — override poll interval (default 10 min)
 *   - Caches the last check timestamp so we don't query npm too aggressively
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { get as httpsGet } from "node:https";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "bosun";
const CACHE_FILE = resolve(__dirname, "logs", ".update-check-cache.json");
const AUTO_UPDATE_STATE_FILE = resolve(__dirname, ".cache", "auto-update-state.json");
const AUTO_UPDATE_FAILURE_LIMIT =
  Number(process.env.BOSUN_AUTO_UPDATE_FAILURE_LIMIT) || 3;
const AUTO_UPDATE_DISABLE_WINDOW_MS =
  Number(process.env.BOSUN_AUTO_UPDATE_DISABLE_WINDOW_MS) || 24 * 60 * 60 * 1000;
const AUTO_UPDATE_RUNTIME_SETTLE_MAX_WAIT_MS = Math.max(
  0,
  Number(process.env.BOSUN_AUTO_UPDATE_RUNTIME_SETTLE_MAX_WAIT_MS || "20000") ||
    20000,
);
const AUTO_UPDATE_RUNTIME_SETTLE_RETRY_MS = Math.max(
  100,
  Number(process.env.BOSUN_AUTO_UPDATE_RUNTIME_SETTLE_RETRY_MS || "500") || 500,
);
const STARTUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (startup notice)
const AUTO_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes (polling loop)
const NPM_LAUNCH_ERROR_CODES = new Set([
  "EINVAL",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ETXTBSY",
]);

function sanitizeNpmEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of ["PWD", "OLDPWD", "INIT_CWD"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim() && !existsSync(value)) {
      delete env[key];
    }
  }
  return env;
}

function isLaunchFailure(err) {
  if (!err) return false;
  if (typeof err.status === "number") return false;
  const code = String(err.code || "").toUpperCase();
  if (NPM_LAUNCH_ERROR_CODES.has(code)) return true;
  const message = String(err.message || "");
  return (
    /\b(EINVAL|ENOENT|EACCES|EPERM)\b/i.test(message) ||
    /not recognized as an internal or external command/i.test(message)
  );
}

function formatAttemptError(label, err) {
  const code = err?.code ? String(err.code) : "unknown";
  const message = String(err?.message || err || "").replace(/\s+/g, " ").trim();
  const summary = message ? message.slice(0, 160) : "no message";
  return `${label} [${code}] ${summary}`;
}

function tryNpmAttempt(label, runner, launchErrors) {
  try {
    return { ok: true, value: runner() };
  } catch (err) {
    if (!isLaunchFailure(err)) {
      throw err;
    }
    launchErrors.push(formatAttemptError(label, err));
    return { ok: false, error: err };
  }
}

function quoteCmdArg(arg) {
  const text = String(arg ?? "");
  if (!/[ \t"&()^|<>]/.test(text)) return text;
  return `"${text.replace(/(["^])/g, "^$1")}"`;
}

function runWindowsCmd(candidate, args, options) {
  const cmdLine = [`"${candidate}"`, ...args.map(quoteCmdArg)].join(" ");
  return execFileSync("cmd.exe", ["/d", "/s", "/c", cmdLine], options);
}

function runNpmCommand(args, options = {}) {
  // Default cwd to the user home directory so that npm never inherits a
  // deleted working directory (e.g. a stale git worktree), which would cause
  // Node's uv_cwd to throw ENOENT before npm even parses its arguments.
  const safeOptions = {
    cwd: os.homedir(),
    ...options,
    env: sanitizeNpmEnv(options.env || process.env),
  };
  const launchErrors = [];

  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    const result = tryNpmAttempt(
      `node ${npmExecPath}`,
      () => execFileSync(process.execPath, [npmExecPath, ...args], safeOptions),
      launchErrors,
    );
    if (result.ok) return result.value;
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
    if (!existsSync(candidate)) continue;
    // On Unix, npm is a shell script with #!/usr/bin/env node which fails
    // when running inside a detached daemon where nvm node is not on PATH.
    // Invoke it directly through process.execPath to bypass the shebang.
    if (process.platform !== "win32") {
      const result = tryNpmAttempt(
        `node ${candidate}`,
        () => execFileSync(process.execPath, [candidate, ...args], safeOptions),
        launchErrors,
      );
      if (result.ok) return result.value;
      continue;
    }
    // On Windows, .cmd/.bat files are batch scripts that can fail with EINVAL
    // on some nvm-for-windows setups when launched directly.
    if (candidate.endsWith(".cmd") || candidate.endsWith(".bat")) {
      const shellResult = tryNpmAttempt(
        `${candidate} (shell)`,
        () => execFileSync(candidate, args, { ...safeOptions, shell: true }),
        launchErrors,
      );
      if (shellResult.ok) return shellResult.value;
      const cmdResult = tryNpmAttempt(
        `${candidate} (cmd.exe)`,
        () => runWindowsCmd(candidate, args, safeOptions),
        launchErrors,
      );
      if (cmdResult.ok) return cmdResult.value;
      continue;
    }
    const directResult = tryNpmAttempt(
      candidate,
      () => execFileSync(candidate, args, safeOptions),
      launchErrors,
    );
    if (directResult.ok) return directResult.value;
  }

  const npmCliCandidates = [
    npmExecPath,
    join(nodeBinDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeBinDir), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);

  for (const cliPath of npmCliCandidates) {
    if (!existsSync(cliPath)) continue;
    const result = tryNpmAttempt(
      `node ${cliPath}`,
      () => execFileSync(process.execPath, [cliPath, ...args], safeOptions),
      launchErrors,
    );
    if (result.ok) return result.value;
  }

  const fallback = process.platform === "win32" ? "npm.cmd" : "npm";
  if (process.platform !== "win32") {
    const result = tryNpmAttempt(
      fallback,
      () => execFileSync(fallback, args, safeOptions),
      launchErrors,
    );
    if (result.ok) return result.value;
  } else {
    // The fallback path also needs shell:true on Windows for .cmd resolution.
    const shellFallback = tryNpmAttempt(
      `${fallback} (shell)`,
      () => execFileSync(fallback, args, { ...safeOptions, shell: true }),
      launchErrors,
    );
    if (shellFallback.ok) return shellFallback.value;
    const cmdFallback = tryNpmAttempt(
      `${fallback} (cmd.exe)`,
      () => runWindowsCmd(fallback, args, safeOptions),
      launchErrors,
    );
    if (cmdFallback.ok) return cmdFallback.value;
  }

  const launchError = new Error(
    `[auto-update] npm launch failed after ${launchErrors.length} attempt(s): ${launchErrors.join(" | ")}`,
  );
  launchError.code = "NPM_LAUNCH_FAILED";
  throw launchError;
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

const defaultAutoUpdateState = {
  failureCount: 0,
  lastFailureReason: null,
  disabledUntil: 0,
  lastNotifiedAt: 0,
};

async function readAutoUpdateState() {
  try {
    const raw = await readFile(AUTO_UPDATE_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaultAutoUpdateState, ...parsed };
  } catch {
    return { ...defaultAutoUpdateState };
  }
}

async function writeAutoUpdateState(state) {
  try {
    await mkdir(dirname(AUTO_UPDATE_STATE_FILE), { recursive: true });
    await writeFile(
      AUTO_UPDATE_STATE_FILE,
      JSON.stringify({ ...defaultAutoUpdateState, ...state }, null, 2),
    );
  } catch {
    // non-critical
  }
}

async function resetAutoUpdateState() {
  await writeAutoUpdateState({ ...defaultAutoUpdateState });
  return { ...defaultAutoUpdateState };
}

function classifyInstallError(err) {
  const message = err?.message || String(err || "");
  const code = String(err?.code || "").toUpperCase();
  if (code === "EINVAL" || message.includes("EINVAL")) return "EINVAL";
  if (code === "NPM_LAUNCH_FAILED") return "NPM_LAUNCH_FAILED";
  if (code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) return "ETIMEDOUT";
  if (code === "ENOENT") return "ENOENT";
  if (code === "EPERM" || code === "EACCES") return "EACCES";
  if (Number.isInteger(err?.status)) return `EXIT_${err.status}`;
  if (code) return code;
  return message.slice(0, 160) || "unknown";
}

async function recordAutoUpdateFailure(state, reason) {
  const now = Date.now();
  const next = {
    ...defaultAutoUpdateState,
    ...state,
    failureCount: (state?.failureCount || 0) + 1,
    lastFailureReason: reason,
  };

  if (!next.disabledUntil && next.failureCount >= AUTO_UPDATE_FAILURE_LIMIT) {
    next.disabledUntil = now + AUTO_UPDATE_DISABLE_WINDOW_MS;
    next.lastNotifiedAt = 0;
  }

  await writeAutoUpdateState(next);
  return next;
}

function isAutoUpdateDisabled(state, now = Date.now()) {
  return Boolean(state?.disabledUntil && now < state.disabledUntil);
}

function buildDisableNotice(state) {
  const hours = Math.round(AUTO_UPDATE_DISABLE_WINDOW_MS / (60 * 60 * 1000));
  const reason = state?.lastFailureReason || "unknown";
  return [
    `[auto-update] :ban: Disabled for ${hours}h after ${state?.failureCount || 0} failures (last: ${reason}).`,
    "Recovery: set BOSUN_SKIP_AUTO_UPDATE=1 or delete .cache/auto-update-state.json then restart.",
  ].join(' ');
}

// ── Registry query ───────────────────────────────────────────────────────────

async function fetchLatestVersion() {
  // Use node:https instead of fetch() to avoid the undici connection-pool
  // handles that cause a libuv assertion crash on Windows:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) [src\win\async.c:76]
  // undici keeps internal uv_async_t handles alive after fetch() completes;
  // calling process.exit() then tears them down mid-close.
  try {
    const version = await new Promise((resolve, reject) => {
      const req = httpsGet(
        `https://registry.npmjs.org/${PKG_NAME}/latest`,
        { headers: { Accept: "application/json" }, timeout: 10000 },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume(); // drain
            return resolve(null);
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            try {
              resolve(JSON.parse(body).version || null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
    if (version) return version;
  } catch {
    // https.get failed, try npm view
  }

  try {
    const out = runNpmCommand(["view", PKG_NAME, "version", "--registry", "https://registry.npmjs.org"], {
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
  if (process.env.BOSUN_SKIP_UPDATE_CHECK) return;

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

  let latest = await fetchLatestVersion();

  if (!latest) {
    console.log("  :alert:  Could not reach npm registry.");
    console.log("  :help:  This can happen if:");
    console.log("     • You're offline or behind a firewall");
    console.log("     • The npm registry is temporarily unavailable");
    console.log("     • The package hasn't been published yet");
    console.log("");
    console.log("  Retrying in 3 seconds...\n");
    await new Promise(r => setTimeout(r, 3000));
    latest = await fetchLatestVersion();
    if (!latest) {
      console.log("  :close: Still unable to reach registry. Try manually:");
      console.log(`     npm install -g ${PKG_NAME}@latest\n`);
      return;
    }
  }

  if (!isNewer(latest, currentVersion)) {
    console.log(`  :check: Already up to date (v${currentVersion})\n`);
    return;
  }

  console.log(`  :box: Update available: v${currentVersion} → v${latest}\n`);

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
      `\n  :check: Updated to v${latest}. Restart bosun to use the new version.\n`,
    );
  } catch (err) {
    console.error(`\n  :close: Update failed: ${err.message}`);
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

function getRequiredRuntimeFiles() {
  const required = [resolve(__dirname, "monitor.mjs")];
  const copilotDir = resolve(__dirname, "node_modules", "@github", "copilot");
  if (process.platform === "win32" && existsSync(copilotDir)) {
    required.push(resolve(copilotDir, "conpty_console_list_agent.js"));
  }
  return required;
}

function listMissingRuntimeFiles() {
  return getRequiredRuntimeFiles().filter((entry) => !existsSync(entry));
}

async function waitForRuntimeFilesToSettle() {
  const startedAt = Date.now();
  let missing = listMissingRuntimeFiles();
  while (
    missing.length > 0 &&
    Date.now() - startedAt < AUTO_UPDATE_RUNTIME_SETTLE_MAX_WAIT_MS
  ) {
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, AUTO_UPDATE_RUNTIME_SETTLE_RETRY_MS);
    });
    missing = listMissingRuntimeFiles();
  }
  return {
    ready: missing.length === 0,
    missing,
    waitedMs: Date.now() - startedAt,
  };
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
 *   1. Runs `npm install -g bosun@<version>`
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
  if (process.env.BOSUN_SKIP_AUTO_UPDATE === "1") {
    console.log("[auto-update] Disabled via BOSUN_SKIP_AUTO_UPDATE=1");
    return;
  }

  const intervalMs =
    Number(process.env.BOSUN_UPDATE_INTERVAL_MS) ||
    opts.intervalMs ||
    AUTO_UPDATE_INTERVAL_MS;
  const startupDelayRaw =
    opts.startupDelayMs ?? process.env.BOSUN_UPDATE_STARTUP_DELAY_MS;
  const startupDelayMs =
    Number.isFinite(Number(startupDelayRaw)) && Number(startupDelayRaw) >= 0
      ? Number(startupDelayRaw)
      : 60 * 1000;
  const onRestart = opts.onRestart || (() => process.exit(0));
  const onNotify = opts.onNotify || ((msg) => console.log(msg));
  const safeNotify = async (msg) => {
    try {
      await Promise.resolve(onNotify(msg));
    } catch (notifyErr) {
      console.warn(
        `[auto-update] notify callback failed: ${notifyErr?.message || notifyErr}`,
      );
    }
  };
  const safeRestart = async (reason) => {
    try {
      await Promise.resolve(onRestart(reason));
    } catch (restartErr) {
      console.error(
        `[auto-update] restart callback failed: ${restartErr?.message || restartErr}`,
      );
    }
  };

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

    let state = await readAutoUpdateState();
    const now = Date.now();

    try {
      if (isAutoUpdateDisabled(state, now)) {
        if (!state.lastNotifiedAt) {
          state = { ...state, lastNotifiedAt: now };
          await writeAutoUpdateState(state);
          const notice = buildDisableNotice(state);
          await safeNotify(notice);
          console.log(notice);
        }
        return;
      }

      if (state.disabledUntil && now >= state.disabledUntil) {
        state = await resetAutoUpdateState();
      }

      const currentVersion = getCurrentVersion();
      const latest = await fetchLatestVersion();

      if (!latest) {
        return; // registry unreachable — try again next cycle
      }

      if (!isNewer(latest, currentVersion)) {
        return; // already up to date
      }

      // ── Update detected! ──────────────────────────────────────────────
      const msg = `[auto-update] :refresh: Update detected: v${currentVersion} → v${latest}. Installing...`;
      console.log(msg);
      await safeNotify(msg);

      try {
        runNpmCommand(["install", "-g", `${PKG_NAME}@${latest}`], {
          timeout: 180000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (installErr) {
        const errMsg = `[auto-update] :close: Install failed: ${installErr.message || installErr}`;
        console.error(errMsg);
        await safeNotify(errMsg);

        let updatedState = await recordAutoUpdateFailure(
          state,
          classifyInstallError(installErr),
        );

        if (updatedState.disabledUntil && !updatedState.lastNotifiedAt) {
          updatedState = { ...updatedState, lastNotifiedAt: Date.now() };
          await writeAutoUpdateState(updatedState);
          const notice = buildDisableNotice(updatedState);
          await safeNotify(notice);
          console.log(notice);
        }
        return;
      }

      // Verify the install actually changed the on-disk version
      const newVersion = getCurrentVersion();
      if (!isNewer(newVersion, currentVersion) && newVersion !== latest) {
        const errMsg = `[auto-update] :alert: Install ran but version unchanged (${newVersion}). Skipping restart.`;
        console.warn(errMsg);
        await safeNotify(errMsg);
        return;
      }

      await writeCache({ lastCheck: Date.now(), latestVersion: latest });
      await resetAutoUpdateState();

      const successMsg = `[auto-update] :check: Updated to v${latest}. Restarting...`;
      console.log(successMsg);
      await safeNotify(successMsg);

      const runtimeStatus = await waitForRuntimeFilesToSettle();
      if (!runtimeStatus.ready) {
        const errMsg = `[auto-update] :alert: Runtime files not ready after update; skipping restart this cycle. Missing: ${runtimeStatus.missing.join(", ")}`;
        console.warn(errMsg);
        await safeNotify(errMsg);
        return;
      }
      if (runtimeStatus.waitedMs >= AUTO_UPDATE_RUNTIME_SETTLE_RETRY_MS) {
        console.log(
          `[auto-update] runtime settled after ${Math.round(runtimeStatus.waitedMs / 1000)}s`,
        );
      }

      // Give Telegram a moment to deliver the notification
      await new Promise((r) => setTimeout(r, 2000));

      await safeRestart(`auto-update v${currentVersion} → v${latest}`);
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

  // First poll after startup delay (default 60s), then every intervalMs
  const runPollSafely = () => {
    poll().catch((err) => {
      console.warn(
        "[auto-update] Poll scheduler error: " + (err?.message || err),
      );
    });
  };

  setTimeout(() => {
    runPollSafely();
    autoUpdateTimer = setInterval(runPollSafely, intervalMs);
  }, startupDelayMs);
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
  console.log("  │  Or:  bosun --update                             │");
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


export const __autoUpdateTestHooks = {
  readAutoUpdateState,
  writeAutoUpdateState,
  resetAutoUpdateState,
  recordAutoUpdateFailure,
  isAutoUpdateDisabled,
  classifyInstallError,
  buildDisableNotice,
  AUTO_UPDATE_STATE_FILE,
  AUTO_UPDATE_FAILURE_LIMIT,
  AUTO_UPDATE_DISABLE_WINDOW_MS,
};
