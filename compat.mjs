#!/usr/bin/env node
/**
 * compat.mjs — Backward compatibility for users migrating from codex-monitor
 *
 * Handles:
 *   1. Legacy env var aliasing: CODEX_MONITOR_X → BOSUN_X
 *   2. Legacy config dir detection: ~/codex-monitor or $CODEX_MONITOR_DIR
 *   3. Migration: copy old config dir to new bosun dir
 *
 * This module is intentionally dependency-free (only Node built-ins) and
 * should be imported as early as possible in the startup path.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Legacy config file names accepted from old codex-monitor installations ───
const LEGACY_CONFIG_NAMES = [
  "codex-monitor.config.json",
  "bosun.config.json",
  ".bosun.json",
  "bosun.json",
  ".env",
];

/**
 * Env vars the old codex-monitor package used that have been renamed.
 * Format: [oldName, newName]
 * Rule: any CODEX_MONITOR_X maps to BOSUN_X by default, but some had
 * different names entirely — those are listed explicitly below.
 */
const EXPLICIT_ALIASES = [
  // Dir / location
  ["CODEX_MONITOR_DIR",                      "BOSUN_DIR"],
  ["CODEX_MONITOR_HOME",                     "BOSUN_HOME"],
  // Runtime flags
  ["CODEX_MONITOR_SKIP_AUTO_UPDATE",         "BOSUN_SKIP_AUTO_UPDATE"],
  ["CODEX_MONITOR_SKIP_UPDATE_CHECK",        "BOSUN_SKIP_UPDATE_CHECK"],
  ["CODEX_MONITOR_UPDATE_INTERVAL_MS",       "BOSUN_UPDATE_INTERVAL_MS"],
  ["CODEX_MONITOR_SKIP_POSTINSTALL",         "BOSUN_SKIP_POSTINSTALL"],
  ["CODEX_MONITOR_INTERACTIVE",              "BOSUN_INTERACTIVE"],
  ["CODEX_MONITOR_PREFLIGHT_DISABLED",       "BOSUN_PREFLIGHT_DISABLED"],
  ["CODEX_MONITOR_PREFLIGHT_RETRY_MS",       "BOSUN_PREFLIGHT_RETRY_MS"],
  ["CODEX_MONITOR_MIN_FREE_GB",              "BOSUN_MIN_FREE_GB"],
  ["CODEX_MONITOR_INSTANCE_ID",              "BOSUN_INSTANCE_ID"],
  ["CODEX_MONITOR_MODE",                     "BOSUN_MODE"],
  ["CODEX_MONITOR_SHELL",                    "BOSUN_SHELL"],
  ["CODEX_MONITOR_SHELL_MODE",               "BOSUN_SHELL_MODE"],
  ["CODEX_MONITOR_PROFILE",                  "BOSUN_PROFILE"],
  ["CODEX_MONITOR_ENV_PROFILE",              "BOSUN_ENV_PROFILE"],
  // Task
  ["CODEX_MONITOR_TASK_LABEL",               "BOSUN_TASK_LABEL"],
  ["CODEX_MONITOR_TASK_LABELS",              "BOSUN_TASK_LABELS"],
  ["CODEX_MONITOR_ENFORCE_TASK_LABEL",       "BOSUN_ENFORCE_TASK_LABEL"],
  ["CODEX_MONITOR_TASK_UPSTREAM",            "BOSUN_TASK_UPSTREAM"],
  // Daemon
  ["CODEX_MONITOR_DAEMON",                   "BOSUN_DAEMON"],
  ["CODEX_MONITOR_DAEMON_RESTART_DELAY_MS",  "BOSUN_DAEMON_RESTART_DELAY_MS"],
  ["CODEX_MONITOR_DAEMON_MAX_RESTARTS",      "BOSUN_DAEMON_MAX_RESTARTS"],
  ["CODEX_MONITOR_DAEMON_INSTANT_CRASH_WINDOW_MS", "BOSUN_DAEMON_INSTANT_CRASH_WINDOW_MS"],
  ["CODEX_MONITOR_DAEMON_MAX_INSTANT_RESTARTS",    "BOSUN_DAEMON_MAX_INSTANT_RESTARTS"],
  // Hooks
  ["CODEX_MONITOR_HOOK_PROFILE",             "BOSUN_HOOK_PROFILE"],
  ["CODEX_MONITOR_HOOK_TARGETS",             "BOSUN_HOOK_TARGETS"],
  ["CODEX_MONITOR_HOOKS_ENABLED",            "BOSUN_HOOKS_ENABLED"],
  ["CODEX_MONITOR_HOOKS_OVERWRITE",          "BOSUN_HOOKS_OVERWRITE"],
  ["CODEX_MONITOR_HOOK_NODE_BIN",            "BOSUN_HOOK_NODE_BIN"],
  ["CODEX_MONITOR_HOOK_BRIDGE_PATH",         "BOSUN_HOOK_BRIDGE_PATH"],
  ["CODEX_MONITOR_HOOK_PREPUSH",             "BOSUN_HOOK_PREPUSH"],
  ["CODEX_MONITOR_HOOK_PRECOMMIT",           "BOSUN_HOOK_PRECOMMIT"],
  ["CODEX_MONITOR_HOOK_TASK_COMPLETE",       "BOSUN_HOOK_TASK_COMPLETE"],
  ["CODEX_MONITOR_HOOKS_BUILTINS_MODE",      "BOSUN_HOOKS_BUILTINS_MODE"],
  ["CODEX_MONITOR_HOOKS_FORCE",              "BOSUN_HOOKS_FORCE"],
  // Sentinel
  ["CODEX_MONITOR_SENTINEL_AUTO_START",      "BOSUN_SENTINEL_AUTO_START"],
  ["CODEX_MONITOR_SENTINEL_STRICT",          "BOSUN_SENTINEL_STRICT"],
  // Prompts
  ["CODEX_MONITOR_PROMPT_WORKSPACE",         "BOSUN_PROMPT_WORKSPACE"],
  // Repo
  ["CODEX_MONITOR_REPO",                     "BOSUN_REPO"],
  ["CODEX_MONITOR_REPO_NAME",                "BOSUN_REPO_NAME"],
  ["CODEX_MONITOR_REPO_ROOT",                "BOSUN_REPO_ROOT"],
  // Config path
  ["CODEX_MONITOR_CONFIG_PATH",              "BOSUN_CONFIG_PATH"],
];

/**
 * Apply all legacy CODEX_MONITOR_* → BOSUN_* env var aliases.
 * Also does a generic pass: any remaining CODEX_MONITOR_X that wasn't in the
 * explicit list is aliased to BOSUN_X.
 *
 * Existing BOSUN_* values are never overwritten (BOSUN_ wins).
 * Safe to call multiple times (idempotent).
 */
export function applyLegacyEnvAliases() {
  // Explicit known renames
  for (const [oldKey, newKey] of EXPLICIT_ALIASES) {
    if (process.env[oldKey] !== undefined && process.env[newKey] === undefined) {
      process.env[newKey] = process.env[oldKey];
    }
  }

  // Generic pass: CODEX_MONITOR_X → BOSUN_X for anything not already mapped
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("CODEX_MONITOR_")) continue;
    const suffix = key.slice("CODEX_MONITOR_".length);
    const newKey = `BOSUN_${suffix}`;
    if (process.env[newKey] === undefined) {
      process.env[newKey] = process.env[key];
    }
  }
}

/**
 * Returns the legacy codex-monitor config directory if it exists and
 * contains config files, null otherwise.
 *
 * Checks in priority order:
 *   1. $CODEX_MONITOR_DIR env var
 *   2. ~/codex-monitor
 *   3. ~/.codex-monitor
 *   4. ~/.config/codex-monitor
 */
export function getLegacyConfigDir() {
  const home =
    process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.APPDATA ||
    null;

  const candidates = [
    process.env.CODEX_MONITOR_DIR || null,
    home ? join(home, "codex-monitor") : null,
    home ? join(home, ".codex-monitor") : null,
    home ? join(home, ".config", "codex-monitor") : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(dir) && hasLegacyMarkers(dir)) {
      return dir;
    }
  }
  return null;
}

function hasLegacyMarkers(dir) {
  return LEGACY_CONFIG_NAMES.some((name) => existsSync(join(dir, name)));
}

/**
 * Returns the target bosun config directory (where we'd migrate to).
 * Does NOT create the directory.
 */
export function getNewConfigDir() {
  const home =
    process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.APPDATA ||
    process.cwd();

  return (
    process.env.BOSUN_DIR ||
    join(home, "bosun")
  );
}

/**
 * Detect if the user has a legacy codex-monitor setup but no bosun setup.
 * Returns { hasLegacy, legacyDir, newDir, alreadyMigrated }
 */
export function detectLegacySetup() {
  const legacyDir = getLegacyConfigDir();
  const newDir = getNewConfigDir();
  const newHasConfig = hasLegacyMarkers(newDir);

  return {
    hasLegacy: legacyDir !== null,
    legacyDir,
    newDir,
    alreadyMigrated: newHasConfig,
  };
}

/**
 * Migrate config files from old codex-monitor dir to new bosun dir.
 * Only copies; never deletes the old directory.
 *
 * Files copied:
 *   .env                            → .env  (with CODEX_MONITOR_ → BOSUN_ substitution)
 *   bosun.config.json           → bosun.config.json
 *   codex-monitor.config.json       → bosun.config.json  (rename)
 *   .bosun.json / bosun.json → as-is
 *
 * Returns { migrated: string[], skipped: string[], errors: string[] }
 */
export function migrateFromLegacy(legacyDir, newDir, { overwrite = false } = {}) {
  const result = { migrated: [], skipped: [], errors: [] };

  try {
    mkdirSync(newDir, { recursive: true });
  } catch (e) {
    result.errors.push(`Could not create ${newDir}: ${e.message}`);
    return result;
  }

  // Files to migrate: [source name, dest name]
  const filePairs = [
    [".env",                     ".env"],
    ["bosun.config.json",    "bosun.config.json"],
    ["codex-monitor.config.json","bosun.config.json"],
    [".bosun.json",          ".bosun.json"],
    ["bosun.json",           "bosun.json"],
  ];

  for (const [srcName, destName] of filePairs) {
    const src = join(legacyDir, srcName);
    const dest = join(newDir, destName);

    if (!existsSync(src)) continue;
    if (existsSync(dest) && !overwrite) {
      result.skipped.push(destName);
      continue;
    }

    try {
      if (srcName === ".env") {
        // Rewrite CODEX_MONITOR_ prefixes to BOSUN_ in .env content
        const content = readFileSync(src, "utf8");
        const updated = rewriteEnvContent(content);
        writeFileSync(dest, updated, "utf8");
      } else {
        copyFileSync(src, dest);
      }
      result.migrated.push(destName);
    } catch (e) {
      result.errors.push(`${destName}: ${e.message}`);
    }
  }

  return result;
}

/**
 * Rewrite .env file content: replace CODEX_MONITOR_X= with BOSUN_X=
 * while preserving comments and blank lines.
 */
function rewriteEnvContent(content) {
  return content
    .split("\n")
    .map((line) => {
      // Match both active vars and commented-out vars
      return line.replace(/^(#?\s*)CODEX_MONITOR_/, "$1BOSUN_");
    })
    .join("\n");
}

/**
 * Remove the legacy codex-monitor config directory after successful migration.
 * Runs in a deferred setTimeout so it doesn't block startup.
 */
function scheduleLegacyCleanup(legacyDir) {
  if (!legacyDir || !existsSync(legacyDir)) return;
  setTimeout(() => {
    try {
      rmSync(legacyDir, { recursive: true, force: true });
      console.log(`[compat] Cleaned up legacy config directory: ${legacyDir}`);
    } catch (err) {
      console.warn(
        `[compat] Could not remove legacy directory ${legacyDir}: ${err.message}`,
      );
    }
  }, 5000);
}

/**
 * If BOSUN_DIR is not set but a legacy codex-monitor dir exists,
 * automatically migrate config to ~/bosun and set BOSUN_DIR to the new location.
 * After successful migration, schedule legacy directory removal.
 *
 * Returns true if legacy dir was detected and migration was performed.
 */
export function autoApplyLegacyDir() {
  // Already set — nothing to do
  if (process.env.BOSUN_DIR) return false;

  const legacyDir = getLegacyConfigDir();
  if (!legacyDir) return false;

  const newDir = getNewConfigDir();

  // If new dir already has config, just use it (already migrated)
  if (hasLegacyMarkers(newDir)) {
    // Legacy dir still exists but new dir is set up — clean up legacy
    scheduleLegacyCleanup(legacyDir);
    return false;
  }

  // Perform migration
  console.log(
    `[compat] Legacy codex-monitor config detected at ${legacyDir} — migrating to ${newDir}...`,
  );
  const result = migrateFromLegacy(legacyDir, newDir);

  if (result.errors.length > 0) {
    console.warn(
      `[compat] Migration had errors: ${result.errors.join(", ")}`,
    );
    // Fall back to legacy dir if migration failed
    process.env.BOSUN_DIR = legacyDir;
    return true;
  }

  if (result.migrated.length > 0) {
    console.log(
      `[compat] Migrated ${result.migrated.length} files to ${newDir}: ${result.migrated.join(", ")}`,
    );
  }

  // Schedule cleanup of legacy directory
  scheduleLegacyCleanup(legacyDir);

  return true;
}

/**
 * Run full compatibility setup: alias env vars + auto-apply legacy dir.
 * Call this before loadConfig().
 */
export function applyAllCompatibility() {
  applyLegacyEnvAliases();
  autoApplyLegacyDir();
}
