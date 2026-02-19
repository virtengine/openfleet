#!/usr/bin/env node
/**
 * compat.mjs — Backward compatibility for users migrating from codex-monitor
 *
 * Handles:
 *   1. Legacy env var aliasing: CODEX_MONITOR_X → OPENFLEET_X
 *   2. Legacy config dir detection: ~/codex-monitor or $CODEX_MONITOR_DIR
 *   3. Migration: copy old config dir to new openfleet dir
 *
 * This module is intentionally dependency-free (only Node built-ins) and
 * should be imported as early as possible in the startup path.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Legacy config file names accepted from old codex-monitor installations ───
const LEGACY_CONFIG_NAMES = [
  "codex-monitor.config.json",
  "openfleet.config.json",
  ".openfleet.json",
  "openfleet.json",
  ".env",
];

/**
 * Env vars the old codex-monitor package used that have been renamed.
 * Format: [oldName, newName]
 * Rule: any CODEX_MONITOR_X maps to OPENFLEET_X by default, but some had
 * different names entirely — those are listed explicitly below.
 */
const EXPLICIT_ALIASES = [
  // Dir / location
  ["CODEX_MONITOR_DIR",                      "OPENFLEET_DIR"],
  ["CODEX_MONITOR_HOME",                     "OPENFLEET_HOME"],
  // Runtime flags
  ["CODEX_MONITOR_SKIP_AUTO_UPDATE",         "OPENFLEET_SKIP_AUTO_UPDATE"],
  ["CODEX_MONITOR_SKIP_UPDATE_CHECK",        "OPENFLEET_SKIP_UPDATE_CHECK"],
  ["CODEX_MONITOR_UPDATE_INTERVAL_MS",       "OPENFLEET_UPDATE_INTERVAL_MS"],
  ["CODEX_MONITOR_SKIP_POSTINSTALL",         "OPENFLEET_SKIP_POSTINSTALL"],
  ["CODEX_MONITOR_INTERACTIVE",              "OPENFLEET_INTERACTIVE"],
  ["CODEX_MONITOR_PREFLIGHT_DISABLED",       "OPENFLEET_PREFLIGHT_DISABLED"],
  ["CODEX_MONITOR_PREFLIGHT_RETRY_MS",       "OPENFLEET_PREFLIGHT_RETRY_MS"],
  ["CODEX_MONITOR_MIN_FREE_GB",              "OPENFLEET_MIN_FREE_GB"],
  ["CODEX_MONITOR_INSTANCE_ID",              "OPENFLEET_INSTANCE_ID"],
  ["CODEX_MONITOR_MODE",                     "OPENFLEET_MODE"],
  ["CODEX_MONITOR_SHELL",                    "OPENFLEET_SHELL"],
  ["CODEX_MONITOR_SHELL_MODE",               "OPENFLEET_SHELL_MODE"],
  ["CODEX_MONITOR_PROFILE",                  "OPENFLEET_PROFILE"],
  ["CODEX_MONITOR_ENV_PROFILE",              "OPENFLEET_ENV_PROFILE"],
  // Task
  ["CODEX_MONITOR_TASK_LABEL",               "OPENFLEET_TASK_LABEL"],
  ["CODEX_MONITOR_TASK_LABELS",              "OPENFLEET_TASK_LABELS"],
  ["CODEX_MONITOR_ENFORCE_TASK_LABEL",       "OPENFLEET_ENFORCE_TASK_LABEL"],
  ["CODEX_MONITOR_TASK_UPSTREAM",            "OPENFLEET_TASK_UPSTREAM"],
  // Daemon
  ["CODEX_MONITOR_DAEMON",                   "OPENFLEET_DAEMON"],
  ["CODEX_MONITOR_DAEMON_RESTART_DELAY_MS",  "OPENFLEET_DAEMON_RESTART_DELAY_MS"],
  ["CODEX_MONITOR_DAEMON_MAX_RESTARTS",      "OPENFLEET_DAEMON_MAX_RESTARTS"],
  ["CODEX_MONITOR_DAEMON_INSTANT_CRASH_WINDOW_MS", "OPENFLEET_DAEMON_INSTANT_CRASH_WINDOW_MS"],
  ["CODEX_MONITOR_DAEMON_MAX_INSTANT_RESTARTS",    "OPENFLEET_DAEMON_MAX_INSTANT_RESTARTS"],
  // Hooks
  ["CODEX_MONITOR_HOOK_PROFILE",             "OPENFLEET_HOOK_PROFILE"],
  ["CODEX_MONITOR_HOOK_TARGETS",             "OPENFLEET_HOOK_TARGETS"],
  ["CODEX_MONITOR_HOOKS_ENABLED",            "OPENFLEET_HOOKS_ENABLED"],
  ["CODEX_MONITOR_HOOKS_OVERWRITE",          "OPENFLEET_HOOKS_OVERWRITE"],
  ["CODEX_MONITOR_HOOK_NODE_BIN",            "OPENFLEET_HOOK_NODE_BIN"],
  ["CODEX_MONITOR_HOOK_BRIDGE_PATH",         "OPENFLEET_HOOK_BRIDGE_PATH"],
  ["CODEX_MONITOR_HOOK_PREPUSH",             "OPENFLEET_HOOK_PREPUSH"],
  ["CODEX_MONITOR_HOOK_PRECOMMIT",           "OPENFLEET_HOOK_PRECOMMIT"],
  ["CODEX_MONITOR_HOOK_TASK_COMPLETE",       "OPENFLEET_HOOK_TASK_COMPLETE"],
  ["CODEX_MONITOR_HOOKS_BUILTINS_MODE",      "OPENFLEET_HOOKS_BUILTINS_MODE"],
  ["CODEX_MONITOR_HOOKS_FORCE",              "OPENFLEET_HOOKS_FORCE"],
  // Sentinel
  ["CODEX_MONITOR_SENTINEL_AUTO_START",      "OPENFLEET_SENTINEL_AUTO_START"],
  ["CODEX_MONITOR_SENTINEL_STRICT",          "OPENFLEET_SENTINEL_STRICT"],
  // Prompts
  ["CODEX_MONITOR_PROMPT_WORKSPACE",         "OPENFLEET_PROMPT_WORKSPACE"],
  // Repo
  ["CODEX_MONITOR_REPO",                     "OPENFLEET_REPO"],
  ["CODEX_MONITOR_REPO_NAME",                "OPENFLEET_REPO_NAME"],
  ["CODEX_MONITOR_REPO_ROOT",                "OPENFLEET_REPO_ROOT"],
  // Config path
  ["CODEX_MONITOR_CONFIG_PATH",              "OPENFLEET_CONFIG_PATH"],
];

/**
 * Apply all legacy CODEX_MONITOR_* → OPENFLEET_* env var aliases.
 * Also does a generic pass: any remaining CODEX_MONITOR_X that wasn't in the
 * explicit list is aliased to OPENFLEET_X.
 *
 * Existing OPENFLEET_* values are never overwritten (OPENFLEET_ wins).
 * Safe to call multiple times (idempotent).
 */
export function applyLegacyEnvAliases() {
  // Explicit known renames
  for (const [oldKey, newKey] of EXPLICIT_ALIASES) {
    if (process.env[oldKey] !== undefined && process.env[newKey] === undefined) {
      process.env[newKey] = process.env[oldKey];
    }
  }

  // Generic pass: CODEX_MONITOR_X → OPENFLEET_X for anything not already mapped
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("CODEX_MONITOR_")) continue;
    const suffix = key.slice("CODEX_MONITOR_".length);
    const newKey = `OPENFLEET_${suffix}`;
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
 * Returns the target openfleet config directory (where we'd migrate to).
 * Does NOT create the directory.
 */
export function getNewConfigDir() {
  const home =
    process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.APPDATA ||
    process.cwd();

  return (
    process.env.OPENFLEET_DIR ||
    join(home, "openfleet")
  );
}

/**
 * Detect if the user has a legacy codex-monitor setup but no openfleet setup.
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
 * Migrate config files from old codex-monitor dir to new openfleet dir.
 * Only copies; never deletes the old directory.
 *
 * Files copied:
 *   .env                            → .env  (with CODEX_MONITOR_ → OPENFLEET_ substitution)
 *   openfleet.config.json           → openfleet.config.json
 *   codex-monitor.config.json       → openfleet.config.json  (rename)
 *   .openfleet.json / openfleet.json → as-is
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
    ["openfleet.config.json",    "openfleet.config.json"],
    ["codex-monitor.config.json","openfleet.config.json"],
    [".openfleet.json",          ".openfleet.json"],
    ["openfleet.json",           "openfleet.json"],
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
        // Rewrite CODEX_MONITOR_ prefixes to OPENFLEET_ in .env content
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
 * Rewrite .env file content: replace CODEX_MONITOR_X= with OPENFLEET_X=
 * while preserving comments and blank lines.
 */
function rewriteEnvContent(content) {
  return content
    .split("\n")
    .map((line) => {
      // Match both active vars and commented-out vars
      return line.replace(/^(#?\s*)CODEX_MONITOR_/, "$1OPENFLEET_");
    })
    .join("\n");
}

/**
 * If OPENFLEET_DIR is not set but CODEX_MONITOR_DIR is (or legacy dir exists),
 * transparently set OPENFLEET_DIR to point at the legacy dir so openfleet reads
 * from it without requiring a migration step.
 *
 * This is the "zero-friction" path: existing users just upgrade the package and
 * it works. Migration is optional (improves going forward).
 */
export function autoApplyLegacyDir() {
  // Already set — nothing to do
  if (process.env.OPENFLEET_DIR) return false;

  const legacyDir = getLegacyConfigDir();
  if (!legacyDir) return false;

  process.env.OPENFLEET_DIR = legacyDir;
  console.log(
    `[compat] Legacy codex-monitor config detected at ${legacyDir} — using it as OPENFLEET_DIR.`,
  );
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
