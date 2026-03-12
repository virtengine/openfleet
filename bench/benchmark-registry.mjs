import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { initLibrary, rebuildManifest } from "../infra/library-manager.mjs";
import { WorkflowEngine } from "../workflow/workflow-engine.mjs";
import { installTemplateSet } from "../workflow/workflow-templates.mjs";
import { normalizeBenchmarkModeState } from "./benchmark-mode.mjs";
import { cmdImport as cmdSwebenchImport } from "./swebench/bosun-swebench.mjs";

const DEFAULT_RUNTIME_TEMPLATE_IDS = Object.freeze(["template-task-lifecycle"]);
const DEFAULT_RUNTIME_OVERRIDES = Object.freeze({
  "template-task-lifecycle": Object.freeze({
    maxParallel: 1,
    pollIntervalMs: 15000,
    agentProfile: "benchmark-agent",
  }),
});

const BASE_BENCHMARK_AGENT_PROFILE = Object.freeze({
  id: "benchmark-agent",
  name: "Benchmark Agent",
  description:
    "Benchmark-focused task agent for reproducible, tool-rich execution in isolated benchmark workspaces.",
  titlePatterns: [
    "\\bbenchmark\\b",
    "\\bswebench\\b",
    "\\[swe-bench\\]",
    "\\[swebench\\]",
  ],
  scopes: ["benchmark", "evaluation", "reproducibility", "swebench"],
  sdk: null,
  model: null,
  promptOverride: null,
  skills: ["background-task-execution"],
  hookProfile: null,
  env: {},
  tags: ["benchmark", "evaluation", "reproducibility", "swebench"],
  agentType: "task",
  enabledTools: null,
  enabledMcpServers: [],
});

const PROVIDERS = Object.freeze([
  {
    id: "swebench",
    name: "SWE-bench",
    description:
      "Task benchmark bridge that imports SWE-bench instances into Bosun tasks and lets the workflow runtime execute them.",
    kind: "task-benchmark",
    supports: {
      launch: true,
      monitor: true,
      workspacePreset: true,
      focusMode: true,
    },
    modeDefaults: {
      requiredTagsAll: ["benchmark"],
      requiredTagsAny: ["swebench"],
      pauseOtherAgents: true,
      holdActiveNonBenchmarkTasks: false,
      maxParallel: 1,
    },
    workspacePreset: {
      recommendedWorkspaceName: "bench-swebench",
      runtimeTemplateIds: DEFAULT_RUNTIME_TEMPLATE_IDS,
      runtimeOverridesById: DEFAULT_RUNTIME_OVERRIDES,
      agentProfileId: BASE_BENCHMARK_AGENT_PROFILE.id,
    },
    launchUi: {
      actionLabel: "Import instances",
      fields: [
        {
          key: "instances",
          label: "Instances JSONL path",
          type: "path",
          required: true,
          description: "Server-local path to the SWE-bench instances JSONL/JSON file.",
        },
        {
          key: "candidates",
          label: "Candidate count",
          type: "number",
          defaultValue: 1,
          min: 1,
          max: 12,
          description: "Optional multi-candidate count per imported task.",
        },
        {
          key: "status",
          label: "Initial status",
          type: "string",
          defaultValue: "todo",
        },
        {
          key: "priority",
          label: "Priority",
          type: "string",
          defaultValue: "high",
        },
        {
          key: "ensureRuntime",
          label: "Install benchmark runtime",
          type: "boolean",
          defaultValue: true,
        },
      ],
    },
    launch: async (payload) =>
      cmdSwebenchImport({
        instances: payload?.instances,
        candidates: payload?.candidates,
        candidateCount: payload?.candidates,
        status: payload?.status,
        priority: payload?.priority,
        ...(payload?.ensureRuntime === false ? { "no-ensure-runtime": true } : {}),
      }),
  },
  {
    id: "library-resolver",
    name: "Library Resolver",
    description:
      "Synthetic library/profile resolution benchmark. Present in the registry so the Benchmark UI can grow beyond task benchmarks.",
    kind: "analysis-benchmark",
    supports: {
      launch: false,
      monitor: false,
      workspacePreset: false,
      focusMode: false,
    },
    comingSoon: true,
    modeDefaults: {
      requiredTagsAll: ["benchmark"],
      requiredTagsAny: ["library-resolver"],
      pauseOtherAgents: false,
      holdActiveNonBenchmarkTasks: false,
      maxParallel: null,
    },
  },
]);

function normalizeProviderId(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function mergeTemplateOverrides(base = {}, extra = {}) {
  const merged = { ...base };
  for (const [templateId, overrides] of Object.entries(extra || {})) {
    merged[templateId] = {
      ...(merged[templateId] || {}),
      ...(overrides || {}),
    };
  }
  return merged;
}

function toCatalogEntry(provider) {
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    kind: provider.kind,
    supports: { ...(provider.supports || {}) },
    comingSoon: provider.comingSoon === true,
    modeDefaults: {
      requiredTagsAll: [...(provider.modeDefaults?.requiredTagsAll || [])],
      requiredTagsAny: [...(provider.modeDefaults?.requiredTagsAny || [])],
      pauseOtherAgents: Boolean(provider.modeDefaults?.pauseOtherAgents),
      holdActiveNonBenchmarkTasks: Boolean(provider.modeDefaults?.holdActiveNonBenchmarkTasks),
      maxParallel: provider.modeDefaults?.maxParallel ?? null,
    },
    workspacePreset: provider.workspacePreset
      ? {
          recommendedWorkspaceName: provider.workspacePreset.recommendedWorkspaceName || "",
          agentProfileId: provider.workspacePreset.agentProfileId || "",
          runtimeTemplateIds: [...(provider.workspacePreset.runtimeTemplateIds || [])],
        }
      : null,
    launchUi: provider.launchUi || null,
  };
}

export function listBenchmarkProviders() {
  return PROVIDERS.map((provider) => toCatalogEntry(provider));
}

export function getBenchmarkProvider(providerId = "") {
  const normalized = normalizeProviderId(providerId);
  return PROVIDERS.find((provider) => provider.id === normalized) || null;
}

export function buildBenchmarkModePreset(providerId = "", overrides = {}) {
  const provider = getBenchmarkProvider(providerId);
  const base = provider?.modeDefaults || {};
  const workspaceDir = String(overrides?.workspaceDir || "").trim();
  return normalizeBenchmarkModeState(
    {
      enabled: overrides?.enabled !== false,
      providerId: provider?.id || normalizeProviderId(overrides?.providerId),
      workspaceId: overrides?.workspaceId || "",
      workspaceDir,
      scopePaths: overrides?.scopePaths || (workspaceDir ? [workspaceDir] : []),
      requiredTagsAll: overrides?.requiredTagsAll || base.requiredTagsAll || [],
      requiredTagsAny: overrides?.requiredTagsAny || base.requiredTagsAny || [],
      pauseOtherAgents:
        typeof overrides?.pauseOtherAgents === "boolean"
          ? overrides.pauseOtherAgents
          : Boolean(base.pauseOtherAgents),
      holdActiveNonBenchmarkTasks:
        typeof overrides?.holdActiveNonBenchmarkTasks === "boolean"
          ? overrides.holdActiveNonBenchmarkTasks
          : Boolean(base.holdActiveNonBenchmarkTasks),
      maxParallel:
        overrides?.maxParallel !== undefined
          ? overrides.maxParallel
          : (base.maxParallel ?? null),
      previousMaxParallel:
        overrides?.previousMaxParallel !== undefined
          ? overrides.previousMaxParallel
          : null,
    },
    { repoRoot: overrides?.repoRoot || workspaceDir || process.cwd() },
  );
}

export function resolveBenchmarkAgentProfilePath(rootDir = "") {
  const normalizedRoot = resolve(rootDir || process.cwd());
  return resolve(normalizedRoot, ".bosun", "profiles", `${BASE_BENCHMARK_AGENT_PROFILE.id}.json`);
}

export function scaffoldBenchmarkAgentProfile(rootDir = "", opts = {}) {
  const normalizedRoot = resolve(rootDir || process.cwd());
  const provider = getBenchmarkProvider(opts?.providerId);
  const profilePath = resolveBenchmarkAgentProfilePath(normalizedRoot);
  mkdirSync(dirname(profilePath), { recursive: true });
  if (existsSync(profilePath)) {
    return {
      id: BASE_BENCHMARK_AGENT_PROFILE.id,
      path: profilePath,
      written: false,
      skipped: true,
    };
  }

  const profile = {
    ...BASE_BENCHMARK_AGENT_PROFILE,
    scopes: uniqueStrings([
      ...BASE_BENCHMARK_AGENT_PROFILE.scopes,
      provider?.id || "",
    ]),
    tags: uniqueStrings([
      ...BASE_BENCHMARK_AGENT_PROFILE.tags,
      provider?.id || "",
      provider?.id ? `benchmark:${provider.id}` : "",
    ]),
  };

  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n", "utf8");
  return {
    id: profile.id,
    path: profilePath,
    written: true,
    skipped: false,
    profile,
  };
}

export function ensureBenchmarkWorkspaceRuntime(rootDir = "", opts = {}) {
  const normalizedRoot = resolve(rootDir || process.cwd());
  const provider = getBenchmarkProvider(opts?.providerId);
  const workflowDir = resolve(normalizedRoot, ".bosun", "workflows");
  const runsDir = resolve(normalizedRoot, ".bosun", "workflow-runs");
  if (!existsSync(normalizedRoot)) {
    return {
      repoRoot: normalizedRoot,
      workflowDir,
      runsDir,
      installed: [],
      skipped: [],
      errors: [{ id: "workspace", error: `Workspace does not exist: ${normalizedRoot}` }],
    };
  }
  const templateIds = Array.isArray(opts?.templateIds) && opts.templateIds.length > 0
    ? opts.templateIds
    : [...(provider?.workspacePreset?.runtimeTemplateIds || DEFAULT_RUNTIME_TEMPLATE_IDS)];
  const overridesById = mergeTemplateOverrides(
    DEFAULT_RUNTIME_OVERRIDES,
    provider?.workspacePreset?.runtimeOverridesById || {},
  );
  const mergedOverrides = mergeTemplateOverrides(overridesById, opts?.overridesById || {});
  const engine = new WorkflowEngine({ workflowDir, runsDir });
  const result = installTemplateSet(engine, templateIds, mergedOverrides);
  return {
    repoRoot: normalizedRoot,
    workflowDir,
    runsDir,
    ...result,
  };
}

export function prepareBenchmarkWorkspacePreset(rootDir = "", opts = {}) {
  const normalizedRoot = resolve(rootDir || process.cwd());
  mkdirSync(normalizedRoot, { recursive: true });
  const libraryInit = initLibrary(normalizedRoot);
  const profile = scaffoldBenchmarkAgentProfile(normalizedRoot, opts);
  const manifest = rebuildManifest(normalizedRoot);
  const runtime =
    opts?.ensureRuntime === false
      ? { repoRoot: normalizedRoot, installed: [], skipped: ["runtime-disabled"], errors: [] }
      : ensureBenchmarkWorkspaceRuntime(normalizedRoot, opts);
  return {
    rootDir: normalizedRoot,
    library: {
      entries: Array.isArray(manifest?.entries) ? manifest.entries.length : 0,
      scaffolded: Array.isArray(libraryInit?.scaffolded?.written)
        ? libraryInit.scaffolded.written.length
        : 0,
    },
    profile,
    runtime,
  };
}

export async function launchBenchmark(providerId = "", payload = {}) {
  const provider = getBenchmarkProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown benchmark provider: ${providerId}`);
  }
  if (provider.supports?.launch !== true || typeof provider.launch !== "function") {
    throw new Error(`Benchmark provider "${provider.name}" does not support UI launch yet`);
  }
  const result = await provider.launch(payload);
  return {
    providerId: provider.id,
    providerName: provider.name,
    ...(result && typeof result === "object" ? result : {}),
  };
}
