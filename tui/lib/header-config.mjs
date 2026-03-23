import { loadConfig } from "../../config/config.mjs";

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function hasValue(value) {
  return String(value || "").trim().length > 0;
}

function resolveProjectLabel(config = {}) {
  const candidates = [
    config?.linearUrl,
    config?.linear?.url,
    config?.kanban?.url,
    config?.kanban?.projectUrl,
    config?.vkPublicUrl,
    config?.vkEndpointUrl,
    config?.projectUrl,
    config?.kanban?.projectId,
    config?.projectId,
  ];
  const label = candidates.find((candidate) => hasValue(candidate));
  return label ? String(label).trim() : "No project";
}

function resolveConfiguredProviders(config = {}) {
  const primaryAgent = String(config?.primaryAgent || "").trim().toLowerCase();
  return {
    claude: primaryAgent === "claude-sdk" || hasValue(process.env.ANTHROPIC_API_KEY),
    codex:
      primaryAgent === "codex-sdk" ||
      config?.codexEnabled === true ||
      hasValue(process.env.OPENAI_API_KEY) ||
      hasValue(process.env.AZURE_OPENAI_API_KEY),
    gemini:
      primaryAgent === "gemini-sdk" ||
      hasValue(process.env.GEMINI_API_KEY) ||
      hasValue(process.env.GOOGLE_API_KEY),
    copilot:
      primaryAgent === "copilot-sdk" ||
      (!isTruthy(process.env.COPILOT_SDK_DISABLED) && (hasValue(process.env.COPILOT_CLI_TOKEN) || hasValue(process.env.GITHUB_PAT))),
  };
}

export function readTuiHeaderConfig(configDir) {
  try {
    const argv = ["node", "bosun-tui"];
    if (configDir) {
      argv.push("--config-dir", String(configDir));
    }
    const config = loadConfig(argv, { reloadEnv: false });
    return {
      configuredProviders: resolveConfiguredProviders(config),
      projectLabel: resolveProjectLabel(config),
    };
  } catch {
    return {
      configuredProviders: {
        claude: hasValue(process.env.ANTHROPIC_API_KEY),
        codex: hasValue(process.env.OPENAI_API_KEY) || hasValue(process.env.AZURE_OPENAI_API_KEY),
        gemini: hasValue(process.env.GEMINI_API_KEY) || hasValue(process.env.GOOGLE_API_KEY),
        copilot: hasValue(process.env.COPILOT_CLI_TOKEN) || hasValue(process.env.GITHUB_PAT),
      },
      projectLabel: "No project",
    };
  }
}
