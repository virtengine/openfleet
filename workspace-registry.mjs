import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

const DEFAULT_REGISTRY = {
  version: 1,
  default_workspace: "primary",
  workspaces: [
    {
      id: "primary",
      name: "Primary Coordinator",
      host: "localhost",
      role: "coordinator",
      capabilities: ["planning", "triage", "routing"],
      model_priorities: ["CODEX:DEFAULT"],
      vk_workspace_id: "primary",
      mentions: ["primary", "coord", "coordinator"],
    },
  ],
};

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeExecutorProfile(profile) {
  if (!profile) return null;
  if (typeof profile === "string") {
    const [executor, variant] = profile.split(":");
    if (!executor) return null;
    return {
      executor: executor.trim().toUpperCase(),
      variant: (variant || "DEFAULT").trim().toUpperCase(),
    };
  }
  if (profile.executor && profile.variant) {
    return {
      executor: String(profile.executor).toUpperCase(),
      variant: String(profile.variant).toUpperCase(),
    };
  }
  if (profile.executor_profile_id) {
    return normalizeExecutorProfile(profile.executor_profile_id);
  }
  return null;
}

function normalizeWorkspace(workspace) {
  if (!workspace) return null;
  const id = normalizeId(workspace.id);
  if (!id) return null;
  const mentions = Array.isArray(workspace.mentions)
    ? workspace.mentions.map(normalizeId).filter(Boolean)
    : [];
  const aliases = Array.isArray(workspace.aliases)
    ? workspace.aliases.map(normalizeId).filter(Boolean)
    : [];
  return {
    ...workspace,
    id,
    mentions,
    aliases,
    role: workspace.role || "workspace",
    model_priorities: Array.isArray(workspace.model_priorities)
      ? workspace.model_priorities
      : [],
  };
}

export async function loadWorkspaceRegistry(options = {}) {
  const registryPath = options.registryPath
    ? resolve(options.registryPath)
    : resolve(__dirname, "workspaces.json");
  let registry = null;
  const errors = [];
  const warnings = [];
  if (existsSync(registryPath)) {
    try {
      const raw = await readFile(registryPath, "utf8");
      registry = JSON.parse(raw);
    } catch (err) {
      errors.push(`Failed to read ${registryPath}: ${err.message || err}`);
      console.warn(
        `[workspace-registry] failed to read ${registryPath}: ${err.message || err}`,
      );
    }
  } else {
    warnings.push(`Registry file not found: ${registryPath} — using defaults`);
  }
  if (!registry) {
    registry = { ...DEFAULT_REGISTRY };
  }

  const workspaces = Array.isArray(registry.workspaces)
    ? registry.workspaces.map(normalizeWorkspace).filter(Boolean)
    : [];
  const defaultWorkspace =
    normalizeId(registry.default_workspace) ||
    DEFAULT_REGISTRY.default_workspace;

  if (workspaces.length === 0) {
    warnings.push("No workspaces configured — using built-in defaults");
  }

  return {
    registry: {
      version: registry.version || DEFAULT_REGISTRY.version,
      default_workspace: defaultWorkspace,
      workspaces,
      registry_path: registryPath,
    },
    // Also spread top-level for backward compat
    version: registry.version || DEFAULT_REGISTRY.version,
    default_workspace: defaultWorkspace,
    workspaces,
    registry_path: registryPath,
    errors,
    warnings,
  };
}

export function resolveWorkspace(registry, candidateId) {
  if (!registry || !Array.isArray(registry.workspaces)) return null;
  const target = normalizeId(candidateId);
  if (!target) return null;
  return (
    registry.workspaces.find((w) => w.id === target) ||
    registry.workspaces.find((w) => w.aliases?.includes(target)) ||
    registry.workspaces.find((w) => w.mentions?.includes(target)) ||
    null
  );
}

export function getLocalWorkspace(registry, envWorkspaceId) {
  if (!registry || !Array.isArray(registry.workspaces)) return null;
  const explicit = normalizeId(envWorkspaceId);
  const defaultId = registry.default_workspace;
  const id = explicit || defaultId || "primary";
  return (
    resolveWorkspace(registry, id) ||
    registry.workspaces[0] ||
    normalizeWorkspace({ id })
  );
}

export function listWorkspaceIds(registry) {
  if (!registry || !Array.isArray(registry.workspaces)) return [];
  return registry.workspaces.map((w) => w.id);
}

export function selectExecutorProfile(workspace, override) {
  const overrideProfile = normalizeExecutorProfile(override);
  if (overrideProfile) {
    return overrideProfile;
  }
  if (!workspace) {
    return { executor: "CODEX", variant: "DEFAULT" };
  }
  for (const entry of workspace.model_priorities || []) {
    const profile = normalizeExecutorProfile(entry);
    if (profile) return profile;
  }
  return { executor: "CODEX", variant: "DEFAULT" };
}

export function parseWorkspaceMentions(text, registry) {
  const targets = new Set();
  const normalizedText = String(text || "");
  const mentionMatches = normalizedText.matchAll(/@([A-Za-z0-9_-]+)/g);
  for (const match of mentionMatches) {
    const id = match[1];
    if (id && id.toLowerCase() === "all") {
      return { targets, broadcast: true };
    }
    const workspace = resolveWorkspace(registry, id);
    if (workspace) {
      targets.add(workspace.id);
    }
  }
  const prefixMatches = normalizedText.matchAll(/\[ws:([A-Za-z0-9_-]+)\]/gi);
  for (const match of prefixMatches) {
    const id = match[1];
    if (id && id.toLowerCase() === "all") {
      return { targets, broadcast: true };
    }
    const workspace = resolveWorkspace(registry, id);
    if (workspace) {
      targets.add(workspace.id);
    }
  }
  return { targets, broadcast: false };
}

export function stripWorkspaceMentions(text, registry) {
  const ids = listWorkspaceIds(registry);
  if (!ids.length) return String(text || "").trim();
  let result = String(text || "");
  for (const id of ids) {
    const mention = new RegExp(`@${id}\\b`, "gi");
    const prefix = new RegExp(`\\[ws:${id}\\]`, "gi");
    result = result.replace(mention, "").replace(prefix, "");
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

export function formatBusMessage({ workspaceId, type, text }) {
  const prefixId = workspaceId || "unknown";
  const typeTag = type ? `[${type}]` : "";
  const prefix = `[ws:${prefixId}]${typeTag}`;
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length === 0) {
    return `${prefix}`;
  }
  lines[0] = `${prefix} ${lines[0]}`.trim();
  return lines.join("\n");
}

export function formatRegistryDiagnostics(errors, warnings) {
  const parts = [];
  if (errors && errors.length > 0) {
    parts.push(
      `❌ Registry errors:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
  if (warnings && warnings.length > 0) {
    parts.push(`⚠️ ${warnings.map((w) => w).join("\n⚠️ ")}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function getDefaultModelPriority() {
  return ["CODEX:DEFAULT", "COPILOT:CLAUDE_OPUS_4_6"];
}
