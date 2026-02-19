/**
 * agent-sdk.mjs — Unified Agent SDK selection (config.toml)
 *
 * Reads ~/.codex/config.toml to determine the primary agent SDK and
 * capability flags for openfleet integrations.
 *
 * Supported primary agents: "codex", "copilot", "claude"
 * Capability flags: steering, subagents, vscode_tools
 */

import { readCodexConfig } from "./codex-config.mjs";

const SUPPORTED_PRIMARY = new Set(["codex", "copilot", "claude"]);
const DEFAULT_PRIMARY = "codex";

const DEFAULT_CAPABILITIES_BY_PRIMARY = {
  codex: {
    steering: true,
    subagents: true,
    vscodeTools: false,
  },
  copilot: {
    steering: false,
    subagents: false,
    vscodeTools: true,
  },
  claude: {
    steering: false,
    subagents: false,
    vscodeTools: false,
  },
};

const DEFAULT_CAPABILITIES = {
  steering: false,
  subagents: false,
  vscodeTools: false,
};

let cachedConfig = null;

function normalizePrimary(value) {
  const primary = String(value || "").trim().toLowerCase();
  if (SUPPORTED_PRIMARY.has(primary)) return primary;
  return DEFAULT_PRIMARY;
}

function parseTomlSection(toml, header) {
  if (!toml || !header) return null;
  const idx = toml.indexOf(header);
  if (idx === -1) return null;
  const afterHeader = idx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const end = nextSection === -1 ? toml.length : nextSection;
  return toml.substring(afterHeader, end);
}

function parseTomlValue(section, key) {
  if (!section) return null;
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m");
  const match = section.match(regex);
  if (!match) return null;
  return match[1].trim();
}

function parseTomlString(raw) {
  if (!raw) return null;
  const trimmed = raw.split(/\s+#/)[0].trim();
  const quote =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (quote) return trimmed.slice(1, -1);
  return trimmed;
}

function parseTomlBool(raw) {
  if (!raw) return null;
  const trimmed = raw.split(/\s+#/)[0].trim().toLowerCase();
  if (trimmed.startsWith("true")) return true;
  if (trimmed.startsWith("false")) return false;
  if (trimmed.startsWith("1")) return true;
  if (trimmed.startsWith("0")) return false;
  return null;
}

function parseCapabilities(section) {
  const steering = parseTomlBool(parseTomlValue(section, "steering"));
  const subagents = parseTomlBool(parseTomlValue(section, "subagents"));
  const vscodeTools =
    parseTomlBool(parseTomlValue(section, "vscode_tools")) ??
    parseTomlBool(parseTomlValue(section, "vscodeTools"));
  return {
    steering,
    subagents,
    vscodeTools,
  };
}

export function parseAgentSdkConfig(toml) {
  const agentSection = parseTomlSection(toml, "[agent_sdk]");
  const capsSection = parseTomlSection(toml, "[agent_sdk.capabilities]");

  const primaryRaw = parseTomlString(parseTomlValue(agentSection, "primary"));
  const primary = normalizePrimary(primaryRaw || DEFAULT_PRIMARY);
  const defaults =
    DEFAULT_CAPABILITIES_BY_PRIMARY[primary] || DEFAULT_CAPABILITIES;

  const parsedCaps = parseCapabilities(capsSection);

  const capabilities = {
    steering:
      parsedCaps.steering !== null ? parsedCaps.steering : defaults.steering,
    subagents:
      parsedCaps.subagents !== null ? parsedCaps.subagents : defaults.subagents,
    vscodeTools:
      parsedCaps.vscodeTools !== null
        ? parsedCaps.vscodeTools
        : defaults.vscodeTools,
  };

  return {
    primary,
    capabilities,
    source: agentSection ? "config.toml" : "defaults",
    raw: {
      primary: primaryRaw,
      capabilities: parsedCaps,
    },
  };
}

export function resolveAgentSdkConfig({ reload = false } = {}) {
  if (cachedConfig && !reload) return cachedConfig;
  const toml = readCodexConfig();
  cachedConfig = parseAgentSdkConfig(toml || "");
  return cachedConfig;
}

export function resetAgentSdkCache() {
  cachedConfig = null;
}
