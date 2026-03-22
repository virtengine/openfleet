import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizeExecutorKey,
  getModelsForExecutor,
  MODEL_ALIASES,
} from "../task/task-complexity.mjs";
import { CONFIG_FILES } from "./config-file-names.mjs";

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return String(value || "")
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferExecutorModelsFromVariant(executor, variant) {
  const normalizedExecutor = normalizeExecutorKey(executor);
  if (!normalizedExecutor) return [];
  const normalizedVariant = String(variant || "DEFAULT")
    .trim()
    .toUpperCase();
  if (!normalizedVariant || normalizedVariant === "DEFAULT") return [];

  const known = getModelsForExecutor(normalizedExecutor);
  const inferred = known.filter((model) => {
    const alias = MODEL_ALIASES[model];
    return (
      String(alias?.variant || "")
        .trim()
        .toUpperCase() === normalizedVariant
    );
  });
  if (inferred.length > 0) return inferred;

  // Fallback for variants encoded as model slug with underscores.
  const slugGuess = normalizedVariant.toLowerCase().replaceAll("_", "-");
  if (known.includes(slugGuess)) return [slugGuess];

  return [];
}

function normalizeExecutorModels(executor, models, variant = "DEFAULT") {
  const normalizedExecutor = normalizeExecutorKey(executor);
  if (!normalizedExecutor) return [];
  const input = parseListValue(models);
  const known = new Set(getModelsForExecutor(normalizedExecutor));
  if (input.length === 0) {
    const inferred = inferExecutorModelsFromVariant(
      normalizedExecutor,
      variant,
    );
    return inferred.length > 0 ? inferred : [...known];
  }
  // Preserve custom/deployment slugs in addition to known models so user-provided
  // model routing survives normalization (for example Azure deployment names).
  return [...new Set(input.filter(Boolean))];
}

function normalizeExecutorEntry(entry, index = 0, total = 1) {
  if (!entry || typeof entry !== "object") return null;
  const executorType = String(entry.executor || "").trim().toUpperCase();
  if (!executorType) return null;
  const variant = String(entry.variant || "DEFAULT").trim() || "DEFAULT";
  const normalized = normalizeExecutorKey(executorType) || "codex";
  const weight = Number(entry.weight);
  const safeWeight = Number.isFinite(weight) ? weight : Math.floor(100 / Math.max(1, total));
  const role =
    String(entry.role || "").trim() ||
    (index === 0 ? "primary" : index === 1 ? "backup" : `executor-${index + 1}`);
  const name =
    String(entry.name || "").trim() ||
    `${normalized}-${String(variant || "default").toLowerCase()}`;
  const models = normalizeExecutorModels(executorType, entry.models, variant);
  const codexProfile = String(
    entry.codexProfile || entry.modelProfile || "",
  ).trim();

  // Provider configuration for the executor (e.g. opencode with specific provider)
  const provider = String(entry.provider || "").trim() || null;
  const providerConfig = entry.providerConfig && typeof entry.providerConfig === "object"
    ? { ...entry.providerConfig }
    : null;

  return {
    name,
    executor: executorType,
    variant,
    weight: safeWeight,
    role,
    enabled: entry.enabled !== false,
    models,
    codexProfile,
    provider,
    providerConfig,
    capabilities: Array.isArray(entry.capabilities)
      ? [...new Set(entry.capabilities.map((value) => String(value || "").trim()).filter(Boolean))]
      : [],
  };
}


const DEFAULT_EXECUTORS = {
  executors: [
    {
      name: "codex-default",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 100,
      role: "primary",
      enabled: true,
    },
  ],
  failover: {
    strategy: "next-in-line",
    maxRetries: 3,
    cooldownMinutes: 5,
    disableOnConsecutiveFailures: 3,
  },
  distribution: "primary-only",
};

function parseExecutorsFromEnv() {
  // EXECUTORS=CODEX:DEFAULT:100:gpt-5.2-codex|gpt-5.1-codex-mini
  const raw = process.env.EXECUTORS;
  if (!raw) return null;
  const entries = raw.split(",").map((e) => e.trim());
  const executors = [];
  const roles = ["primary", "backup", "tertiary"];
  for (let i = 0; i < entries.length; i++) {
    const parts = entries[i].split(":");
    if (parts.length < 2) continue;
    const executorType = parts[0].toUpperCase();
    const models = normalizeExecutorModels(
      executorType,
      parts[3] || "",
      parts[1] || "DEFAULT",
    );
    executors.push({
      name: `${parts[0].toLowerCase()}-${parts[1].toLowerCase()}`,
      executor: executorType,
      variant: parts[1],
      weight: parts[2] ? Number(parts[2]) : Math.floor(100 / entries.length),
      role: roles[i] || `executor-${i + 1}`,
      enabled: true,
      models,
    });
  }
  return executors.length ? executors : null;
}


function findExecutorMetadataMatch(entry, candidates, index = 0) {
  const entryExecutor = normalizeExecutorKey(entry?.executor);
  const entryVariant = String(entry?.variant || "DEFAULT")
    .trim()
    .toUpperCase();
  const entryRole = String(entry?.role || "")
    .trim()
    .toLowerCase();

  const exact = candidates.find((candidate) =>
    normalizeExecutorKey(candidate?.executor) === entryExecutor &&
    String(candidate?.variant || "DEFAULT").trim().toUpperCase() === entryVariant &&
    String(candidate?.role || "").trim().toLowerCase() === entryRole
  );
  if (exact) return exact;

  const byExecutorAndVariant = candidates.find((candidate) =>
    normalizeExecutorKey(candidate?.executor) === entryExecutor &&
    String(candidate?.variant || "DEFAULT").trim().toUpperCase() === entryVariant
  );
  if (byExecutorAndVariant) return byExecutorAndVariant;

  return candidates[index] || null;
}

export function loadExecutorConfig(configDir, configData) {
  // 1. Try env var
  const fromEnv = parseExecutorsFromEnv();

  // 2. Try config file
  let fromFile = null;
  if (configData && typeof configData === "object") {
    fromFile = configData.executors ? configData : null;
  }
  if (!fromFile) {
    for (const name of CONFIG_FILES) {
      const p = resolve(configDir, name);
      if (existsSync(p)) {
        try {
          const raw = JSON.parse(readFileSync(p, "utf8"));
          fromFile = raw.executors ? raw : null;
          break;
        } catch {
          /* invalid JSON — skip */
        }
      }
    }
  }

  const baseExecutors =
    fromEnv || fromFile?.executors || DEFAULT_EXECUTORS.executors;
  const executors = (Array.isArray(baseExecutors) ? baseExecutors : [])
    .map((entry, index, arr) => normalizeExecutorEntry(entry, index, arr.length))
    .filter(Boolean);

  // Preserve file-defined metadata (for example codexProfile) even when
  // execution topology comes from EXECUTORS env.
  if (fromEnv && Array.isArray(fromFile?.executors) && executors.length > 0) {
    const fileExecutors = fromFile.executors
      .map((entry, index, arr) => normalizeExecutorEntry(entry, index, arr.length))
      .filter(Boolean);

    for (let index = 0; index < executors.length; index++) {
      const current = executors[index];
      const match = findExecutorMetadataMatch(current, fileExecutors, index);
      if (!match) continue;
      const merged = { ...current };
      if (typeof match.name === "string" && match.name.trim()) {
        merged.name = match.name.trim();
      }
      if (typeof match.enabled === "boolean") {
        merged.enabled = match.enabled;
      }
      if (Array.isArray(match.models) && match.models.length > 0) {
        merged.models = [...new Set(match.models)];
      }
      if (match.codexProfile) {
        merged.codexProfile = match.codexProfile;
      }
      executors[index] = {
        ...merged,
      };
    }
  }
  const failover = fromFile?.failover || {
    strategy:
      process.env.FAILOVER_STRATEGY || DEFAULT_EXECUTORS.failover.strategy,
    maxRetries: Number(
      process.env.FAILOVER_MAX_RETRIES || DEFAULT_EXECUTORS.failover.maxRetries,
    ),
    cooldownMinutes: Number(
      process.env.FAILOVER_COOLDOWN_MIN ||
        DEFAULT_EXECUTORS.failover.cooldownMinutes,
    ),
    disableOnConsecutiveFailures: Number(
      process.env.FAILOVER_DISABLE_AFTER ||
        DEFAULT_EXECUTORS.failover.disableOnConsecutiveFailures,
    ),
  };
  const distribution =
    fromFile?.distribution ||
    process.env.EXECUTOR_DISTRIBUTION ||
    DEFAULT_EXECUTORS.distribution;

  return { executors, failover, distribution };
}

// ── Executor Scheduler ───────────────────────────────────────────────────────

export class ExecutorScheduler {
  constructor(config) {
    this.executors = config.executors.filter((e) => e.enabled !== false);
    this.failover = config.failover;
    this.distribution = config.distribution;
    this._roundRobinIndex = 0;
    this._failureCounts = new Map(); // name → consecutive failures
    this._disabledUntil = new Map(); // name → timestamp
    this._workspaceActiveCount = new Map(); // workspaceId → current active executor count
    this._workspaceConfigs = new Map(); // workspaceId → { maxConcurrent, pool, weight }
  }

  /**
   * Register workspace executor config for concurrency tracking.
   * @param {string} workspaceId
   * @param {{ maxConcurrent?: number, pool?: string, weight?: number }} wsExecutorConfig
   */
  registerWorkspace(workspaceId, wsExecutorConfig = {}) {
    if (!workspaceId) return;
    this._workspaceConfigs.set(workspaceId, {
      maxConcurrent: wsExecutorConfig.maxConcurrent ?? 3,
      pool: wsExecutorConfig.pool ?? "shared",
      weight: wsExecutorConfig.weight ?? 1.0,
      executors: wsExecutorConfig.executors ?? null,
    });
    if (!this._workspaceActiveCount.has(workspaceId)) {
      this._workspaceActiveCount.set(workspaceId, 0);
    }
  }

  /**
   * Check if a workspace has available executor slots.
   * @param {string} [workspaceId]
   * @returns {boolean}
   */
  hasAvailableSlot(workspaceId) {
    if (!workspaceId) return true; // no workspace scope — always available
    const config = this._workspaceConfigs.get(workspaceId);
    if (!config) return true; // no config registered — no limit
    const active = this._workspaceActiveCount.get(workspaceId) || 0;
    return active < config.maxConcurrent;
  }

  /**
   * Acquire an executor slot for a workspace.
   * @param {string} [workspaceId]
   * @returns {boolean} true if slot acquired, false if at limit
   */
  acquireSlot(workspaceId) {
    if (!workspaceId) return true;
    if (!this.hasAvailableSlot(workspaceId)) return false;
    this._workspaceActiveCount.set(
      workspaceId,
      (this._workspaceActiveCount.get(workspaceId) || 0) + 1,
    );
    return true;
  }

  /**
   * Release an executor slot for a workspace.
   * @param {string} [workspaceId]
   */
  releaseSlot(workspaceId) {
    if (!workspaceId) return;
    const current = this._workspaceActiveCount.get(workspaceId) || 0;
    this._workspaceActiveCount.set(workspaceId, Math.max(0, current - 1));
  }

  /**
   * Get workspace executor usage summary.
   * @returns {Array<{ workspaceId: string, active: number, maxConcurrent: number, pool: string, weight: number }>}
   */
  getWorkspaceSummary() {
    const result = [];
    for (const [wsId, config] of this._workspaceConfigs) {
      result.push({
        workspaceId: wsId,
        active: this._workspaceActiveCount.get(wsId) || 0,
        ...config,
      });
    }
    return result;
  }

  nextForTask(task = {}, workspaceId) {
    const kind = String(task?.kind || task?.type || "").trim().toLowerCase();
    const available = this._getAvailable();
    if (!available.length) {
      return this.next(workspaceId);
    }

    const heavyKinds = new Set(["build", "test", "validation", "diff", "pre-push", "heavy"]);
    const isHeavy = heavyKinds.has(kind);
    const matchesCapability = (executor, capability) => Array.isArray(executor?.capabilities) && executor.capabilities.some((value) => String(value || "").trim().toLowerCase() === capability);

    if (isHeavy) {
      const heavyExecutor = available.find((executor) =>
        matchesCapability(executor, kind) || matchesCapability(executor, "heavy") || matchesCapability(executor, "validation")
      );
      if (heavyExecutor) return heavyExecutor;
    } else if (kind) {
      const lightExecutor = available.find((executor) =>
        matchesCapability(executor, kind) || matchesCapability(executor, "light") || matchesCapability(executor, "chat") || matchesCapability(executor, "plan")
      );
      if (lightExecutor) return lightExecutor;
    }

    return this.next(workspaceId);
  }
  /** Get the next executor based on distribution strategy */
  next(workspaceId) {
    // Check workspace slot availability before selecting
    if (workspaceId && !this.hasAvailableSlot(workspaceId)) {
      return null; // workspace at executor capacity
    }

    const available = this._getAvailable();
    if (!available.length) {
      // All disabled — reset and use primary
      this._disabledUntil.clear();
      this._failureCounts.clear();
      return this.executors[0];
    }

    // For dedicated pools, filter to workspace-assigned executors
    if (workspaceId) {
      const wsConfig = this._workspaceConfigs.get(workspaceId);
      if (wsConfig?.pool === "dedicated" && wsConfig.executors) {
        const dedicated = available.filter((e) =>
          wsConfig.executors.includes(e.name),
        );
        if (dedicated.length) {
          return this._selectByStrategy(dedicated);
        }
      }
    }

    return this._selectByStrategy(available);
  }

  _selectByStrategy(available) {
    switch (this.distribution) {
      case "round-robin":
        return this._roundRobin(available);
      case "primary-only":
        return available[0];
      case "weighted":
      default:
        return this._weightedSelect(available);
    }
  }

  /** Report a failure for an executor */
  recordFailure(executorName) {
    const count = (this._failureCounts.get(executorName) || 0) + 1;
    this._failureCounts.set(executorName, count);
    if (count >= this.failover.disableOnConsecutiveFailures) {
      const until = Date.now() + this.failover.cooldownMinutes * 60 * 1000;
      this._disabledUntil.set(executorName, until);
      this._failureCounts.set(executorName, 0);
    }
  }

  /** Report a success for an executor */
  recordSuccess(executorName) {
    this._failureCounts.set(executorName, 0);
    this._disabledUntil.delete(executorName);
  }

  /** Get failover executor when current one fails */
  getFailover(currentName) {
    const available = this._getAvailable().filter(
      (e) => e.name !== currentName,
    );
    if (!available.length) return null;

    switch (this.failover.strategy) {
      case "weighted-random":
        return this._weightedSelect(available);
      case "round-robin":
        return available[0];
      case "next-in-line":
      default: {
        // Find the next one by role priority
        const roleOrder = [
          "primary",
          "backup",
          "tertiary",
          ...Array.from({ length: 20 }, (_, i) => `executor-${i + 1}`),
        ];
        available.sort(
          (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role),
        );
        return available[0];
      }
    }
  }

  /** Get summary for display */
  getSummary() {
    const total = this.executors.reduce((s, e) => s + e.weight, 0);
    return this.executors.map((e) => {
      const pct = total > 0 ? Math.round((e.weight / total) * 100) : 0;
      const disabled = this._isDisabled(e.name);
      return {
        ...e,
        percentage: pct,
        status: disabled ? "cooldown" : e.enabled ? "active" : "disabled",
        consecutiveFailures: this._failureCounts.get(e.name) || 0,
      };
    });
  }

  /** Format a display string like "COPILOT ⇄ CODEX (50/50)" */
  toDisplayString() {
    const summary = this.getSummary().filter((e) => e.status === "active");
    if (!summary.length) return "No executors available";
    return summary
      .map((e) => `${e.executor}:${e.variant}(${e.percentage}%)`)
      .join(" ⇄ ");
  }

  _getAvailable() {
    return this.executors.filter(
      (e) => e.enabled !== false && !this._isDisabled(e.name),
    );
  }

  _isDisabled(name) {
    const until = this._disabledUntil.get(name);
    if (!until) return false;
    if (Date.now() >= until) {
      this._disabledUntil.delete(name);
      return false;
    }
    return true;
  }

  _roundRobin(available) {
    const idx = this._roundRobinIndex % available.length;
    this._roundRobinIndex++;
    return available[idx];
  }

  _weightedSelect(available) {
    const totalWeight = available.reduce((s, e) => s + (e.weight || 1), 0);
    let r = Math.random() * totalWeight;
    for (const e of available) {
      r -= e.weight || 1;
      if (r <= 0) return e;
    }
    return available[available.length - 1];
  }
}



