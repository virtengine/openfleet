/**
 * task-context.mjs — Runtime task context helpers
 *
 * Centralizes "is this currently a Bosun-managed task?" checks so hook and
 * attribution behaviors can stay task-scoped by default.
 */

const MODE_TASK = "task";
const MODE_ALWAYS = "always";
const MODE_OFF = "off";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeScopedMode(value) {
  const raw = normalizeText(value);
  if (!raw) return null;

  if ([
    MODE_TASK,
    "tasks",
    "task-only",
    "task_only",
    "scoped",
    "task-scoped",
    "task_scoped",
  ].includes(raw)) {
    return MODE_TASK;
  }

  if ([
    MODE_ALWAYS,
    "all",
    "global",
    "unscoped",
  ].includes(raw)) {
    return MODE_ALWAYS;
  }

  if ([
    MODE_OFF,
    "none",
    "disabled",
    "disable",
  ].includes(raw)) {
    return MODE_OFF;
  }

  if (TRUE_VALUES.has(raw)) return MODE_ALWAYS;
  if (FALSE_VALUES.has(raw)) return MODE_OFF;
  return null;
}

/**
 * Parse a scoped mode string into one of: "task" | "always" | "off".
 *
 * @param {unknown} value
 * @param {"task"|"always"|"off"} [fallback="task"]
 * @returns {"task"|"always"|"off"}
 */
export function parseScopedMode(value, fallback = MODE_TASK) {
  const primary = normalizeScopedMode(value);
  if (primary) return primary;
  const fallbackMode = normalizeScopedMode(fallback);
  return fallbackMode || MODE_TASK;
}

/**
 * Parse truthy/falsy env-style values.
 *
 * @param {unknown} value
 * @param {boolean} [fallback=false]
 * @returns {boolean}
 */
export function isEnvFlagEnabled(value, fallback = false) {
  const raw = normalizeText(value);
  if (!raw) return fallback;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  return fallback;
}

/**
 * Resolve the active task ID from supported env aliases.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveBosunTaskId(env = process.env) {
  const candidates = [
    env.BOSUN_TASK_ID,
    env.VE_TASK_ID,
    env.VK_TASK_ID,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

/**
 * Whether this process is marked as managed by Bosun.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isBosunManagedSession(env = process.env) {
  return (
    isEnvFlagEnabled(env.BOSUN_MANAGED, false) ||
    isEnvFlagEnabled(env.VE_MANAGED, false)
  );
}

/**
 * True only when running inside an actively managed Bosun task.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function hasBosunTaskContext(env = process.env) {
  return Boolean(resolveBosunTaskId(env)) && isBosunManagedSession(env);
}

/**
 * Decide whether Bosun co-author attribution should be applied.
 *
 * Modes:
 * - task (default): only for managed task context
 * - always: always add attribution
 * - off: never add attribution
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.taskId]
 * @param {"task"|"always"|"off"} [options.mode]
 * @returns {boolean}
 */
export function shouldAddBosunCoAuthor(options = {}) {
  const env = options.env || process.env;
  const mode = parseScopedMode(
    options.mode ??
      env.BOSUN_COAUTHOR_MODE ??
      env.BOSUN_ATTRIBUTION_MODE,
    MODE_TASK,
  );
  if (mode === MODE_OFF) return false;
  if (mode === MODE_ALWAYS) return true;

  const explicitTaskId = String(options.taskId || "").trim();
  if (explicitTaskId) return true;
  return hasBosunTaskContext(env);
}

/**
 * Decide whether automatic git-hook installation should run.
 *
 * Modes:
 * - task (default): only for managed task context
 * - always: always install if hooks dir exists
 * - off: never auto-install
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {"task"|"always"|"off"} [options.mode]
 * @returns {boolean}
 */
export function shouldAutoInstallGitHooks(options = {}) {
  const env = options.env || process.env;
  const mode = parseScopedMode(
    options.mode ??
      env.BOSUN_AUTO_GIT_HOOKS_MODE ??
      env.BOSUN_GIT_HOOKS_MODE,
    MODE_ALWAYS,
  );
  if (mode === MODE_OFF) return false;
  if (mode === MODE_ALWAYS) return true;
  return hasBosunTaskContext(env);
}

/**
 * Decide whether agent hook bridge handlers should execute.
 *
 * `BOSUN_HOOKS_FORCE=1` remains a hard override for compatibility.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function shouldRunAgentHookBridge(env = process.env) {
  if (isEnvFlagEnabled(env.BOSUN_HOOKS_FORCE, false)) return true;
  return hasBosunTaskContext(env);
}
