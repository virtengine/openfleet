function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function isEnabledFlag(value, fallback = true) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function titleCaseWords(value) {
  return toTrimmedString(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const SHELL_RUNTIME_VARIANTS = Object.freeze([
  { id: "codex-sdk", label: "Codex", family: "openai", runtime: "shell + sdk" },
  { id: "claude-sdk", label: "Claude", family: "anthropic", runtime: "shell + sdk" },
  { id: "copilot-sdk", label: "Copilot", family: "copilot", runtime: "shell + sdk" },
  { id: "opencode-sdk", label: "OpenCode", family: "openai-compatible", runtime: "shell + sdk" },
  { id: "gemini-sdk", label: "Gemini", family: "google", runtime: "shell + sdk" },
]);

export const INTERNAL_TASK_SDK_VARIANTS = Object.freeze([
  { id: "auto", label: "Auto" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "copilot", label: "Copilot" },
  { id: "opencode", label: "OpenCode" },
  { id: "gemini", label: "Gemini" },
]);

function parseExecutorPool(rawValue) {
  const entries = [];
  for (const chunk of String(rawValue || "").split(",")) {
    const entry = toTrimmedString(chunk);
    if (!entry) continue;
    const [executor = "", variant = "", weight = "", ...modelParts] = entry.split(":");
    entries.push({
      raw: entry,
      executor: toTrimmedString(executor).toUpperCase(),
      variant: toTrimmedString(variant).toUpperCase(),
      weight: Number.parseInt(toTrimmedString(weight), 10) || 0,
      model: toTrimmedString(modelParts.join(":")) || null,
    });
  }
  return entries;
}

function summarizePool(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "No weighted executor pool configured.";
  }
  const executorNames = entries
    .map((entry) => titleCaseWords(entry.executor))
    .filter(Boolean);
  const distinct = [...new Set(executorNames)];
  return `${entries.length} pool entr${entries.length === 1 ? "y" : "ies"} across ${distinct.length} runtime${distinct.length === 1 ? "" : "s"}: ${distinct.join(", ")}.`;
}

export function buildAgentConfigurationGuide(rawSettings = {}, providerInventory = null) {
  const settings = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  const primaryShellId = toTrimmedString(settings.PRIMARY_AGENT || "codex-sdk") || "codex-sdk";
  const internalTaskSdk = toTrimmedString(settings.INTERNAL_EXECUTOR_SDK || "auto") || "auto";
  const executorMode = toTrimmedString(settings.EXECUTOR_MODE || "internal") || "internal";
  const executorDistribution = toTrimmedString(settings.EXECUTOR_DISTRIBUTION || "primary-only") || "primary-only";
  const executorPool = parseExecutorPool(settings.EXECUTORS || "");
  const defaultProviderId = toTrimmedString(
    providerInventory?.defaultProviderId ||
    settings.BOSUN_PROVIDER_DEFAULT ||
    "",
  );
  const providerItems = Array.isArray(providerInventory?.items)
    ? providerInventory.items.map((item) => ({
        providerId: toTrimmedString(item?.providerId),
        label: toTrimmedString(item?.label || item?.providerId),
        enabled: item?.enabled !== false,
        authenticated: item?.auth?.authenticated === true,
        canRun: item?.auth?.canRun === true,
        preferredMode: toTrimmedString(item?.auth?.preferredMode || ""),
        adapterId: toTrimmedString(item?.adapterId || ""),
      }))
    : [];

  return {
    shellRuntime: {
      title: "Interactive Shell Runtime",
      summary: "This is the runtime Bosun uses for direct chat sessions, manual agent commands, and session continuation.",
      current: primaryShellId,
      settingKeys: ["PRIMARY_AGENT"],
      items: SHELL_RUNTIME_VARIANTS.map((variant) => ({
        ...variant,
        selected: variant.id === primaryShellId,
        enabled: !isEnabledFlag(settings[`${variant.id.split("-")[0].toUpperCase()}_SDK_DISABLED`], false),
      })),
      note: "Choose one primary shell runtime here. This does not by itself control weighted task routing or internal harness providers.",
    },
    taskRunner: {
      title: "Internal Task Runner",
      summary: "This is the built-in task pool Bosun uses when EXECUTOR_MODE is internal or hybrid.",
      current: internalTaskSdk,
      executorMode,
      distribution: executorDistribution,
      settingKeys: [
        "EXECUTOR_MODE",
        "INTERNAL_EXECUTOR_SDK",
        "INTERNAL_EXECUTOR_PARALLEL",
        "INTERNAL_EXECUTOR_TIMEOUT_MS",
      ],
      items: INTERNAL_TASK_SDK_VARIANTS.map((variant) => ({
        ...variant,
        selected: variant.id === internalTaskSdk,
      })),
      note: "Use 'auto' if you want Bosun to choose an SDK family. Pin this only when you need predictable task-runner behavior.",
    },
    routingPool: {
      title: "Weighted Task Routing Pool",
      summary: "This optional pool distributes task runs across multiple runtimes and failover variants.",
      current: executorDistribution,
      settingKeys: ["EXECUTORS", "EXECUTOR_DISTRIBUTION", "FAILOVER_STRATEGY"],
      entries: executorPool,
      note: summarizePool(executorPool),
    },
    providerLayer: {
      title: "Internal Harness Providers",
      summary: "These providers back the internal harness and provider-based execution paths using OAuth sessions or API keys.",
      current: defaultProviderId || null,
      settingKeys: ["BOSUN_PROVIDER_DEFAULT", "BOSUN_HARNESS_ENABLED", "BOSUN_HARNESS_SOURCE"],
      items: providerItems,
      note: providerItems.length > 0
        ? "Configure auth only for the providers you actually want the internal harness to use."
        : "Provider inventory unavailable in this surface.",
    },
  };
}
