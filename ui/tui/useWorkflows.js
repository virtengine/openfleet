import * as ReactModule from "react";

const React = ReactModule.default ?? ReactModule;
const useCallback = ReactModule.useCallback ?? React.useCallback;
const useEffect = ReactModule.useEffect ?? React.useEffect;
const useState = ReactModule.useState ?? React.useState;

import { loadConfig } from "../../config/config.mjs";
import { CONFIG_FILES } from "../../config/config-file-names.mjs";
import { listWorkflowSummaries, parseWorkflowInput } from "../../workflow/workflow-cli.mjs";
import { WorkflowEngine } from "../../workflow/workflow-engine.mjs";

function resolveConfigFilePath(config) {
  const configDir = String(config?.configDir || "").trim();
  if (configDir) {
    for (const fileName of CONFIG_FILES) {
      const filePath = resolve(configDir, fileName);
      if (existsSync(filePath)) return filePath;
    }
    return resolve(configDir, CONFIG_FILES[0]);
  }
  return resolve(process.cwd(), ".bosun", "bosun.config.json");
}

function readConfigDocument(config) {
  const filePath = resolveConfigFilePath(config);
  try {
    const raw = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : {};
    return { filePath, raw: raw && typeof raw === "object" ? raw : {} };
  } catch {
    return { filePath, raw: {} };
  }
}

function writeConfigDocument(filePath, raw) {
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function summarizeWorkflowDefinition(entry = {}) {
  const requiredInputs = entry?.requiredInputs || entry?.required_inputs || entry?.inputSchema || {};
  return {
    ...entry,
    requiredInputs,
    schedule: entry?.schedule || entry?.trigger || "manual",
    lastRunAt: entry?.lastRunAt || entry?.lastRun || null,
    lastResult: entry?.lastResult || entry?.status || "-",
  };
}

function createEngine(config) {
  const configPath = resolveConfigFilePath(config);
  const configDir = dirname(configPath);
  return new WorkflowEngine({
    workflowDir: resolve(configDir, "workflows"),
    runsDir: resolve(configDir, "workflow-runs"),
    services: {},
  });
}

export function useWorkflows(config) {
  const resolvedConfig = config || loadConfig(process.argv);
  const [workflows, setWorkflows] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const engine = createEngine(resolvedConfig);
      const summaries = await Promise.resolve(listWorkflowSummaries(resolvedConfig));
      const normalized = (Array.isArray(summaries) ? summaries : []).map(summarizeWorkflowDefinition);
      setWorkflows(normalized);
      setHistory(engine.getRunHistory(null, 50));
      setError(null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [resolvedConfig]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const workflowMap = useMemo(
    () => new Map((workflows || []).map((workflow) => [workflow.id, workflow])),
    [workflows],
  );

  const getRunDetail = useCallback((runId) => {
    try {
      return createEngine(resolvedConfig).getRunDetail(runId);
    } catch {
      return null;
    }
  }, [resolvedConfig]);

  const triggerWorkflow = useCallback(async (workflowId, input = {}) => {
    const engine = createEngine(resolvedConfig);
    const payload = typeof input === "string" ? parseWorkflowInput(input) : input;
    return engine.execute(workflowId, payload, { force: true, triggerSource: "manual" });
  }, [resolvedConfig]);

  const cancelRun = useCallback(async (runId) => {
    return createEngine(resolvedConfig).cancelRun(runId, { reason: "Cancelled from TUI" });
  }, [resolvedConfig]);

  const toggleWorkflow = useCallback(async (workflowId) => {
    const { filePath, raw } = readConfigDocument(resolvedConfig);
    const next = { ...raw, workflows: { ...(raw.workflows || {}) } };
    const current = next.workflows[workflowId] && typeof next.workflows[workflowId] === "object"
      ? { ...next.workflows[workflowId] }
      : {};
    current.enabled = current.enabled === false ? true : false;
    next.workflows[workflowId] = current;
    writeConfigDocument(filePath, next);
    await refresh();
    return current.enabled;
  }, [refresh, resolvedConfig]);

  const uninstallWorkflow = useCallback(async (workflowId) => {
    const { filePath, raw } = readConfigDocument(resolvedConfig);
    const nextWorkflows = { ...(raw.workflows || {}) };
    delete nextWorkflows[workflowId];
    writeConfigDocument(filePath, { ...raw, workflows: nextWorkflows });
    await refresh();
    return true;
  }, [refresh, resolvedConfig]);

  return {
    workflows,
    workflowMap,
    history,
    loading,
    error,
    refresh,
    getRunDetail,
    triggerWorkflow,
    cancelRun,
    toggleWorkflow,
    uninstallWorkflow,
  };
}

export default useWorkflows;
