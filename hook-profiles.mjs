import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HOOK_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const LEGACY_BRIDGE_SNIPPET = "scripts/openfleet/agent-hook-bridge.mjs";
const DEFAULT_BRIDGE_SCRIPT_PATH = resolve(__dirname, "agent-hook-bridge.mjs");

function getHookNodeBinary() {
  const configured = String(process.env.OPENFLEET_HOOK_NODE_BIN || "").trim();
  return configured || "node";
}

function getHookBridgeScriptPath() {
  const configured = String(
    process.env.OPENFLEET_HOOK_BRIDGE_PATH || "",
  ).trim();
  return configured || DEFAULT_BRIDGE_SCRIPT_PATH;
}

export const HOOK_PROFILES = Object.freeze([
  "strict",
  "balanced",
  "lightweight",
  "none",
]);

const PRESET_FLAGS = Object.freeze({
  strict: {
    includeSessionHooks: true,
    includePreCommit: true,
    includePrePush: true,
    includeTaskComplete: true,
  },
  balanced: {
    includeSessionHooks: true,
    includePreCommit: false,
    includePrePush: true,
    includeTaskComplete: true,
  },
  lightweight: {
    includeSessionHooks: true,
    includePreCommit: false,
    includePrePush: false,
    includeTaskComplete: false,
  },
  none: {
    includeSessionHooks: false,
    includePreCommit: false,
    includePrePush: false,
    includeTaskComplete: false,
  },
});

const PRESET_COMMANDS = Object.freeze({
  SessionStart: Object.freeze([
    {
      id: "session-start-log",
      command:
        'echo "[hook] Agent session started: task=${VE_TASK_ID} sdk=${VE_SDK} branch=${VE_BRANCH_NAME}"',
      description: "Log agent session start for audit trail",
      blocking: false,
      timeout: 10_000,
    },
  ]),
  SessionStop: Object.freeze([
    {
      id: "session-stop-log",
      command:
        'echo "[hook] Agent session ended: task=${VE_TASK_ID} sdk=${VE_SDK}"',
      description: "Log agent session end for audit trail",
      blocking: false,
      timeout: 10_000,
    },
  ]),
  PrePush: Object.freeze([
    {
      id: "prepush-go-vet",
      command: "go vet ./...",
      description: "Run go vet before push",
      blocking: true,
      timeout: 120_000,
    },
    {
      id: "prepush-go-build",
      command: "go build ./...",
      description: "Verify Go build succeeds before push",
      blocking: true,
      timeout: 300_000,
    },
  ]),
  PreCommit: Object.freeze([
    {
      id: "precommit-gofmt",
      command: "gofmt -l .",
      description: "Check Go formatting before commit",
      blocking: false,
      timeout: 30_000,
    },
  ]),
  TaskComplete: Object.freeze([
    {
      id: "task-complete-audit",
      command: 'echo "[hook] Task completed: ${VE_TASK_ID} — ${VE_TASK_TITLE}"',
      description: "Audit log for task completion",
      blocking: false,
      timeout: 10_000,
    },
  ]),
});

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return defaultValue;
}

function quoteArg(arg) {
  const text = String(arg ?? "");
  if (!text) return "''";
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(args) {
  return args.map((item) => quoteArg(item)).join(" ");
}

function makeBridgeCommandTokens(agent, event) {
  return [
    getHookNodeBinary(),
    getHookBridgeScriptPath(),
    "--agent",
    agent,
    "--event",
    event,
  ];
}

function isBridgeCommandString(command) {
  return String(command || "").includes("agent-hook-bridge.mjs");
}

function isPortableNodeCommandToken(token) {
  const normalized = String(token || "").trim().toLowerCase();
  return normalized === "node";
}

function isPortableBridgeScriptToken(token) {
  const raw = String(token || "");
  return raw === DEFAULT_BRIDGE_SCRIPT_PATH || raw === LEGACY_BRIDGE_SNIPPET;
}

function isCopilotBridgeCommandPortable(commandTokens) {
  if (!Array.isArray(commandTokens) || commandTokens.length < 2) return false;
  if (!isBridgeCommandString(commandTokens.join(" "))) return false;
  return (
    isPortableNodeCommandToken(commandTokens[0]) &&
    isPortableBridgeScriptToken(commandTokens[1])
  );
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeProfile(profile) {
  const raw = String(profile || "")
    .trim()
    .toLowerCase();
  if (HOOK_PROFILES.includes(raw)) return raw;
  return "strict";
}

function normalizeOverrideCommands(rawValue) {
  if (rawValue == null) return null;
  const raw = String(rawValue).trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (["none", "off", "disable", "disabled"].includes(lowered)) {
    return [];
  }
  const commands = raw
    .split(/\s*;;\s*|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return commands;
}

function mapCommandsToHooks(event, commands) {
  return commands.map((command, idx) => {
    const defaults = PRESET_COMMANDS[event]?.[0] || {};
    const idBase = event.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      id: `${idBase}-custom-${idx + 1}`,
      command,
      description:
        defaults.description || `Custom ${event} hook command #${idx + 1}`,
      blocking:
        event === "PrePush" ||
        event === "PreCommit" ||
        event === "PrePR" ||
        defaults.blocking ||
        false,
      sdks: ["*"],
      timeout: defaults.timeout || DEFAULT_TIMEOUT_MS,
    };
  });
}

export function normalizeHookTargets(value) {
  if (Array.isArray(value)) {
    const arr = value
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);
    return [
      ...new Set(
        arr.filter((item) => ["codex", "claude", "copilot"].includes(item)),
      ),
    ];
  }

  const raw = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const unique = [...new Set(raw)];
  const filtered = unique.filter((item) =>
    ["codex", "claude", "copilot", "all"].includes(item),
  );

  if (filtered.includes("all")) return ["codex", "claude", "copilot"];
  if (filtered.length === 0) return ["codex", "claude", "copilot"];
  return filtered;
}

export function buildHookScaffoldOptionsFromEnv(env = process.env) {
  const profile = normalizeProfile(env.OPENFLEET_HOOK_PROFILE);
  return {
    enabled: parseBoolean(env.OPENFLEET_HOOKS_ENABLED, true),
    profile,
    targets: normalizeHookTargets(env.OPENFLEET_HOOK_TARGETS),
    overwriteExisting: parseBoolean(env.OPENFLEET_HOOKS_OVERWRITE, false),
    commands: {
      SessionStart: normalizeOverrideCommands(
        env.OPENFLEET_HOOK_SESSION_START,
      ),
      SessionStop: normalizeOverrideCommands(
        env.OPENFLEET_HOOK_SESSION_STOP,
      ),
      PrePush: normalizeOverrideCommands(env.OPENFLEET_HOOK_PREPUSH),
      PreCommit: normalizeOverrideCommands(env.OPENFLEET_HOOK_PRECOMMIT),
      TaskComplete: normalizeOverrideCommands(
        env.OPENFLEET_HOOK_TASK_COMPLETE,
      ),
    },
  };
}

export function buildCanonicalHookConfig(options = {}) {
  const profile = normalizeProfile(options.profile);
  const flags = { ...PRESET_FLAGS[profile] };
  const commandOverrides = options.commands || {};

  const hooks = {};

  if (flags.includeSessionHooks) {
    hooks.SessionStart = deepClone(PRESET_COMMANDS.SessionStart).map(
      (item) => ({
        ...item,
        sdks: ["*"],
      }),
    );
    hooks.SessionStop = deepClone(PRESET_COMMANDS.SessionStop).map((item) => ({
      ...item,
      sdks: ["*"],
    }));
  }
  if (flags.includePrePush) {
    hooks.PrePush = deepClone(PRESET_COMMANDS.PrePush).map((item) => ({
      ...item,
      sdks: ["*"],
    }));
  }
  if (flags.includePreCommit) {
    hooks.PreCommit = deepClone(PRESET_COMMANDS.PreCommit).map((item) => ({
      ...item,
      sdks: ["*"],
    }));
  }
  if (flags.includeTaskComplete) {
    hooks.TaskComplete = deepClone(PRESET_COMMANDS.TaskComplete).map(
      (item) => ({
        ...item,
        sdks: ["*"],
      }),
    );
  }

  for (const event of [
    "SessionStart",
    "SessionStop",
    "PrePush",
    "PreCommit",
    "TaskComplete",
  ]) {
    const override = commandOverrides[event];
    if (override === null || override === undefined) continue;
    if (override.length === 0) {
      delete hooks[event];
      continue;
    }
    hooks[event] = mapCommandsToHooks(event, override);
  }

  return {
    $schema: DEFAULT_HOOK_SCHEMA,
    description:
      "Agent lifecycle hooks for openfleet. Compatible with Codex, Claude Code, and Copilot CLI.",
    hooks,
    meta: {
      profile,
      generatedBy: "openfleet setup",
      generatedAt: new Date().toISOString(),
    },
  };
}

function createCopilotHookConfig() {
  return {
    version: 1,
    sessionStart: [
      {
        type: "command",
        command: makeBridgeCommandTokens("copilot", "sessionStart"),
        timeout: 60,
      },
    ],
    sessionEnd: [
      {
        type: "command",
        command: makeBridgeCommandTokens("copilot", "sessionEnd"),
        timeout: 60,
      },
    ],
    preToolUse: {
      "*": [
        {
          type: "command",
          command: makeBridgeCommandTokens("copilot", "preToolUse"),
          timeout: 300,
        },
      ],
    },
    postToolUse: {
      "*": [
        {
          type: "command",
          command: makeBridgeCommandTokens("copilot", "postToolUse"),
          timeout: 120,
        },
      ],
    },
  };
}

function createClaudeHookConfig() {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildShellCommand(
                makeBridgeCommandTokens("claude", "UserPromptSubmit"),
              ),
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: buildShellCommand(
                makeBridgeCommandTokens("claude", "PreToolUse"),
              ),
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: buildShellCommand(
                makeBridgeCommandTokens("claude", "PostToolUse"),
              ),
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildShellCommand(
                makeBridgeCommandTokens("claude", "Stop"),
              ),
            },
          ],
        },
      ],
    },
  };
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function mergeClaudeSettings(existing, generated) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};

  const existingHooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const mergedHooks = { ...existingHooks };
  for (const [event, generatedEntries] of Object.entries(generated.hooks)) {
    let existingEntries = Array.isArray(mergedHooks[event])
      ? [...mergedHooks[event]]
      : [];

    existingEntries = existingEntries.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const commands = Array.isArray(entry.hooks)
        ? entry.hooks.map((h) => String(h?.command || ""))
        : [];
      const hasLegacyBridge = commands.some((cmd) => isBridgeCommandString(cmd));
      return !hasLegacyBridge;
    });

    for (const generatedEntry of generatedEntries) {
      const exists = existingEntries.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const sameMatcher =
          String(entry.matcher || "") === String(generatedEntry.matcher || "");
        if (!sameMatcher) return false;

        const entryCommands = Array.isArray(entry.hooks)
          ? entry.hooks.map((h) => String(h?.command || ""))
          : [];
        const generatedCommands = generatedEntry.hooks.map((h) =>
          String(h.command || ""),
        );
        return generatedCommands.every((cmd) => entryCommands.includes(cmd));
      });
      if (!exists) {
        existingEntries.push(generatedEntry);
      }
    }

    mergedHooks[event] = existingEntries;
  }

  base.hooks = mergedHooks;
  return base;
}

function hasLegacyBridgeInCopilotConfig(config) {
  if (!config || typeof config !== "object") return false;
  const events = [
    ...((Array.isArray(config.sessionStart) && config.sessionStart) || []),
    ...((Array.isArray(config.sessionEnd) && config.sessionEnd) || []),
    ...Object.values(config.preToolUse || {}).flatMap((hooks) =>
      Array.isArray(hooks) ? hooks : [],
    ),
    ...Object.values(config.postToolUse || {}).flatMap((hooks) =>
      Array.isArray(hooks) ? hooks : [],
    ),
  ];

  let foundAnyBridgeHook = false;
  for (const entry of events) {
    const command = entry?.command;
    if (Array.isArray(command) && command.some((part) => isBridgeCommandString(part))) {
      foundAnyBridgeHook = true;
      if (!isCopilotBridgeCommandPortable(command)) return true;
      continue;
    }

    if (typeof command === "string" && isBridgeCommandString(command)) {
      foundAnyBridgeHook = true;
      return true;
    }
  }

  if (!foundAnyBridgeHook) return false;

  const scan = (value) => {
    if (typeof value === "string") {
      return value.includes(LEGACY_BRIDGE_SNIPPET);
    }
    if (Array.isArray(value)) {
      return value.some((item) => scan(item));
    }
    if (!value || typeof value !== "object") return false;
    return Object.values(value).some((item) => scan(item));
  };
  return scan(config);
}

function buildDisableEnv(hookConfig) {
  const hasPrePush = Array.isArray(hookConfig.hooks?.PrePush);
  const hasTaskComplete = Array.isArray(hookConfig.hooks?.TaskComplete);

  return {
    OPENFLEET_HOOKS_BUILTINS_MODE:
      hasPrePush || hasTaskComplete ? "auto" : "off",
    OPENFLEET_HOOKS_DISABLE_PREPUSH: hasPrePush ? "0" : "1",
    OPENFLEET_HOOKS_DISABLE_TASK_COMPLETE: hasTaskComplete ? "0" : "1",
  };
}

export function scaffoldAgentHookFiles(repoRoot, options = {}) {
  const root = resolve(repoRoot || process.cwd());
  const targets = normalizeHookTargets(options.targets);
  const overwriteExisting = parseBoolean(options.overwriteExisting, false);
  const enabled = parseBoolean(options.enabled, true);

  const result = {
    enabled,
    profile: normalizeProfile(options.profile),
    targets,
    written: [],
    updated: [],
    skipped: [],
    warnings: [],
    env: {},
  };

  if (!enabled) {
    result.env = {
      OPENFLEET_HOOKS_BUILTINS_MODE: "off",
      OPENFLEET_HOOKS_DISABLE_PREPUSH: "1",
      OPENFLEET_HOOKS_DISABLE_TASK_COMPLETE: "1",
    };
    return result;
  }

  const codexHookConfig = buildCanonicalHookConfig(options);
  result.env = buildDisableEnv(codexHookConfig);

  if (targets.includes("codex")) {
    const codexPath = resolve(root, ".codex", "hooks.json");
    const existedBefore = existsSync(codexPath);
    if (existedBefore && !overwriteExisting) {
      result.skipped.push(relative(root, codexPath));
    } else {
      writeJson(codexPath, codexHookConfig);
      if (existedBefore) {
        result.updated.push(relative(root, codexPath));
      } else {
        result.written.push(relative(root, codexPath));
      }
    }
  }

  if (targets.includes("copilot")) {
    const copilotPath = resolve(
      root,
      ".github",
      "hooks",
      "openfleet.hooks.json",
    );
    const config = createCopilotHookConfig();
    const existedBefore = existsSync(copilotPath);
    const existingCopilot = loadJson(copilotPath);
    const forceLegacyMigration =
      hasLegacyBridgeInCopilotConfig(existingCopilot);

    if (existedBefore && !overwriteExisting && !forceLegacyMigration) {
      result.skipped.push(relative(root, copilotPath));
    } else {
      writeJson(copilotPath, config);
      if (existedBefore) {
        result.updated.push(relative(root, copilotPath));
        if (forceLegacyMigration) {
          result.warnings.push(
            `${relative(root, copilotPath)} contained legacy bridge path and was auto-updated`,
          );
        }
      } else {
        result.written.push(relative(root, copilotPath));
      }
    }
  }

  if (targets.includes("claude")) {
    const claudePath = resolve(root, ".claude", "settings.local.json");
    const generated = createClaudeHookConfig();
    const existedBefore = existsSync(claudePath);
    const existing = loadJson(claudePath);

    if (existing === null && existsSync(claudePath)) {
      result.warnings.push(
        `${relative(root, claudePath)} exists but is not valid JSON; skipped`,
      );
    } else {
      const merged = mergeClaudeSettings(existing, generated);
      writeJson(claudePath, merged);
      if (existedBefore) {
        result.updated.push(relative(root, claudePath));
      } else {
        result.written.push(relative(root, claudePath));
      }
    }
  }

  return result;
}
