import * as ReactModule from "react";
import htm from "htm";
import * as ink from "ink";
import TextInput from "ink-text-input";

import { ANSI_COLORS } from "./constants.js";
import {
  buildWorkflowHistoryRows,
  buildWorkflowTemplateRows,
  createWorkflowTriggerFormState,
  reduceWorkflowStatusEvent,
  tickWorkflowStatusState,
  toggleWorkflowTreeNode,
  workflowResultColor,
} from "./workflows-screen-helpers.js";

const React = ReactModule.default ?? ReactModule;
const useEffect = ReactModule.useEffect ?? React.useEffect;
const useMemo = ReactModule.useMemo ?? React.useMemo;
const useState = ReactModule.useState ?? React.useState;
const html = htm.bind(React.createElement);

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;

const MAX_TREE_LINES = 24;
const MAX_TREE_DEPTH = 8;

function renderTreeLines(value, expandedPaths, path = "root", depth = 0, lines = []) {
  if (lines.length >= MAX_TREE_LINES) return lines;
  if (depth > MAX_TREE_DEPTH) {
    lines.push({ key: path, path, depth, label: `${path.split(".").at(-1)}: …`, expandable: false });
    return lines;
  }
  const isObject = value && typeof value === "object";
  if (!isObject) {
    lines.push({ key: path, path, depth, label: `${path.split(".").at(-1)}: ${String(value)}`, expandable: false });
    return lines;
  }

  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
  const isExpanded = expandedPaths.has(path) || depth === 0;
  lines.push({
    key: path,
    path,
    depth,
    label: `${path.split(".").at(-1)} ${isExpanded ? "▾" : "▸"}`,
    expandable: true,
  });
  if (!isExpanded) return lines;
  for (const [key, child] of entries) {
    if (lines.length >= MAX_TREE_LINES) break;
    renderTreeLines(child, expandedPaths, `${path}.${key}`, depth + 1, lines);
  }
  return lines;
}

function WorkflowDetail({ detail, expandedPaths, selectedTreePath }) {
  const lines = useMemo(() => renderTreeLines(detail, expandedPaths), [detail, expandedPaths]);
  return html`
    <${Box} flexDirection="column" borderStyle="round" paddingX=${1} marginTop=${1}>
      <${Text} bold>Run detail<//>
      ${lines.slice(0, 24).map((line) => html`
        <${Text} key=${line.key} inverse=${selectedTreePath === line.path} color=${line.expandable ? "cyan" : undefined}>
          ${" ".repeat(line.depth * 2)}${line.label}
        <//>
      `)}
    <//>
  `;
}

function TriggerForm({ template, formState, activeFieldIndex, onChange }) {
  const activeField = formState.fields[activeFieldIndex] || null;
  return html`
    <${Box} flexDirection="column" borderStyle="round" paddingX=${1} marginTop=${1}>
      <${Text} bold>Trigger ${template?.name || template?.id}<//>
      ${formState.fields.map((field, index) => html`
        <${Box} key=${field.id}>
          <${Text} color=${field.required ? "yellow" : undefined}>${field.label}${field.required ? "*" : ""}: <//>
          ${index === activeFieldIndex
            ? html`<${TextInput} value=${field.value} onChange=${(next) => onChange(field.id, next)} />`
            : html`<${Text}>${field.value || "-"}<//>`}
        <//>
      `)}
      <${Text} color=${ANSI_COLORS.muted}>Ctrl+S submit · Esc cancel · ${activeField?.description || ""}<//>
    <//>
  `;
}

function clampIndex(index, length) {
  if (!length) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function resolveRunIdForInspect(focusArea, selectedHistory, selectedTemplate, historyRows) {
  if (selectedHistory?.runId && focusArea === "history") return selectedHistory.runId;
  if (!selectedTemplate) return null;
  const matchingRun = (Array.isArray(historyRows) ? historyRows : []).find((row) => {
    if (!row?.runId) return false;
    return row.workflowId === selectedTemplate.id || row.workflowName === selectedTemplate.id;
  });
  return matchingRun?.runId || selectedHistory?.runId || null;
}

export default function WorkflowsScreen({ workflowState, wsState }) {
  const [templateIndex, setTemplateIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [focusArea, setFocusArea] = useState("templates");
  const [inspectingRunId, setInspectingRunId] = useState(null);
  const [expandedPaths, setExpandedPaths] = useState(() => new Set(["root"]));
  const [selectedTreePath, setSelectedTreePath] = useState("root");
  const [triggerTemplateId, setTriggerTemplateId] = useState(null);
  const [triggerForm, setTriggerForm] = useState({ fields: [], values: {} });
  const [triggerFieldIndex, setTriggerFieldIndex] = useState(0);
  const [statusLine, setStatusLine] = useState("");
  const [liveState, setLiveState] = useState(undefined);

  useEffect(() => {
    const events = Array.isArray(wsState?.workflows) ? [...wsState.workflows].reverse() : [];
    let nextState = undefined;
    for (const event of events) nextState = reduceWorkflowStatusEvent(nextState, event, event?.timestamp || Date.now());
    setLiveState(nextState);
  }, [wsState?.workflows]);

  useEffect(() => {
    if (!(liveState?.activeRuns instanceof Map) || liveState.activeRuns.size === 0) return undefined;
    const timer = setInterval(() => {
      setLiveState((current) => tickWorkflowStatusState(current));
    }, 120);
    return () => clearInterval(timer);
  }, [liveState]);

  const templateRows = useMemo(
    () => buildWorkflowTemplateRows(workflowState?.workflows || [], {
      activeRuns: liveState?.activeRuns,
      flashByWorkflowId: liveState?.flashByWorkflowId,
      now: Date.now(),
    }),
    [workflowState?.workflows, liveState],
  );

  const historyRows = useMemo(() => {
    const baseHistory = Array.isArray(workflowState?.history) ? workflowState.history : [];
    const liveHistory = Array.isArray(liveState?.history) ? liveState.history : [];
    return buildWorkflowHistoryRows([...liveHistory, ...baseHistory]);
  }, [workflowState?.history, liveState]);

  const selectedTemplate = templateRows[templateIndex] || null;
  const selectedHistory = historyRows[historyIndex] || null;
  const inspectingDetail = inspectingRunId
    ? workflowState?.getRunDetail?.(inspectingRunId) || null
    : (selectedHistory?.runId ? workflowState?.getRunDetail?.(selectedHistory.runId) || null : null);
  const detailLines = useMemo(
    () => (inspectingDetail ? renderTreeLines(inspectingDetail.detail || inspectingDetail, expandedPaths) : []),
    [expandedPaths, inspectingDetail],
  );

  useEffect(() => {
    setTemplateIndex((current) => clampIndex(current, templateRows.length));
  }, [templateRows.length]);

  useEffect(() => {
    setHistoryIndex((current) => clampIndex(current, historyRows.length));
  }, [historyRows.length]);

  useEffect(() => {
    if (!inspectingRunId) return;
    if (!detailLines.length) {
      setSelectedTreePath("root");
      return;
    }
    if (!detailLines.some((line) => line.path === selectedTreePath)) {
      setSelectedTreePath(detailLines[0].path);
    }
  }, [detailLines, inspectingRunId, selectedTreePath]);

  useInput((input, key) => {
    if (triggerTemplateId) {
      if (key.escape) {
        setTriggerTemplateId(null);
        setStatusLine("Trigger cancelled.");
        return;
      }
      if (key.downArrow || input === "\t") {
        setTriggerFieldIndex((current) => Math.min(current + 1, Math.max(0, triggerForm.fields.length - 1)));
        return;
      }
      if (key.upArrow) {
        setTriggerFieldIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.ctrl && input === "s") {
        const payload = { ...triggerForm.values };
        Promise.resolve(workflowState?.triggerWorkflow?.(triggerTemplateId, payload))
          .then(() => {
            setStatusLine(`Triggered ${triggerTemplateId}.`);
            workflowState?.refresh?.();
          })
          .catch((error) => {
            setStatusLine(String(error?.message || error || `Failed to trigger ${triggerTemplateId}.`));
          })
          .finally(() => {
            setTriggerTemplateId(null);
          });
        return;
      }
      return;
    }

    if (inspectingRunId) {
      if (key.escape) {
        setInspectingRunId(null);
        return;
      }
      if (key.downArrow) {
        const currentIndex = Math.max(0, detailLines.findIndex((line) => line.path === selectedTreePath));
        const nextLine = detailLines[Math.min(currentIndex + 1, Math.max(0, detailLines.length - 1))];
        if (nextLine?.path) setSelectedTreePath(nextLine.path);
        return;
      }
      if (key.upArrow) {
        const currentIndex = Math.max(0, detailLines.findIndex((line) => line.path === selectedTreePath));
        const nextLine = detailLines[Math.max(0, currentIndex - 1)];
        if (nextLine?.path) setSelectedTreePath(nextLine.path);
        return;
      }
      if (input === " ") {
        setExpandedPaths((current) => toggleWorkflowTreeNode(current, selectedTreePath));
        return;
      }
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      setFocusArea((current) => (current === "templates" ? "history" : "templates"));
      return;
    }
    if (key.downArrow) {
      if (focusArea === "templates") setTemplateIndex((current) => Math.min(current + 1, Math.max(0, templateRows.length - 1)));
      else setHistoryIndex((current) => Math.min(current + 1, Math.max(0, historyRows.length - 1)));
      return;
    }
    if (key.upArrow) {
      if (focusArea === "templates") setTemplateIndex((current) => Math.max(0, current - 1));
      else setHistoryIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (input?.toLowerCase() === "t" && selectedTemplate) {
      setTriggerTemplateId(selectedTemplate.id);
      setTriggerForm(createWorkflowTriggerFormState(
        workflowState?.workflowMap?.get(selectedTemplate.id)?.requiredInputs ||
        workflowState?.workflowMap?.get(selectedTemplate.id)?.required_inputs || {},
      ));
      setTriggerFieldIndex(0);
      return;
    }
    if (input?.toLowerCase() === "e" && selectedTemplate) {
      Promise.resolve(workflowState?.toggleWorkflow?.(selectedTemplate.id))
        .then((enabled) => setStatusLine(`${selectedTemplate.id} ${enabled ? "enabled" : "disabled"}.`))
        .catch((error) => setStatusLine(String(error?.message || error || `Failed to toggle ${selectedTemplate.id}.`)));
      return;
    }
    if (input?.toLowerCase() === "i" || key.return) {
      const runId = resolveRunIdForInspect(focusArea, selectedHistory, selectedTemplate, historyRows);
      if (!runId) return;
      setInspectingRunId(runId);
      setSelectedTreePath("root");
      return;
    }
    if (key.delete && selectedTemplate) {
      Promise.resolve(workflowState?.uninstallWorkflow?.(selectedTemplate.id))
        .then(() => setStatusLine(`Uninstalled ${selectedTemplate.id}.`))
        .catch((error) => setStatusLine(String(error?.message || error || `Failed to uninstall ${selectedTemplate.id}.`)));
      return;
    }
    if (input?.toLowerCase() === "c" && selectedHistory?.runId) {
      Promise.resolve(workflowState?.cancelRun?.(selectedHistory.runId))
        .then((result) => {
          if (result?.ok) setStatusLine(`Cancel requested for ${selectedHistory.runId}.`);
          else setStatusLine(String(result?.error || `Unable to cancel ${selectedHistory.runId}.`));
        })
        .catch((error) => setStatusLine(String(error?.message || error || `Failed to cancel ${selectedHistory.runId}.`)));
    }
  });

  const updateTriggerValue = (fieldId, value) => {
    setTriggerForm((current) => ({
      fields: current.fields.map((field) => field.id === fieldId ? { ...field, value } : field),
      values: { ...current.values, [fieldId]: value },
    }));
  };

  return html`
    <${Box} flexDirection="column">
      <${Text} bold>Workflows<//>
      <${Text} color=${ANSI_COLORS.muted}>Templates, live runs, and recent history from the workflow engine.</${Text}>

      <${Box} marginTop=${1}>
        <${Box} flexDirection="column" width="60%" borderStyle="round" paddingX=${1} marginRight=${1}>
          <${Text} bold inverse=${focusArea === "templates"}>Installed templates<//>
          <${Text} color=${ANSI_COLORS.accent}>Name                      Type       Enabled  Last Run  Last Result  Schedule/Trigger<//>
          ${templateRows.length
            ? templateRows.map((row, index) => html`
                <${Text} key=${row.id} inverse=${focusArea === "templates" && index === templateIndex}>
                  ${String(row.name).padEnd(25)} ${String(row.type).padEnd(10)} ${String(row.enabled).padEnd(8)} ${String(row.lastRun).padEnd(9)} ${String(row.lastResult).padEnd(12)} ${row.scheduleOrTrigger}
                <//>
              `)
            : html`<${Text} color=${ANSI_COLORS.muted}>No workflows installed.<//>`}
        <//>

        <${Box} flexDirection="column" width="40%" borderStyle="round" paddingX=${1}>
          <${Text} bold inverse=${focusArea === "history"}>Recent runs<//>
          <${Text} color=${ANSI_COLORS.accent}>Result     Start    Duration  Workflow<//>
          ${historyRows.length
            ? historyRows.map((row, index) => html`
                <${Text} key=${row.runId} inverse=${focusArea === "history" && index === historyIndex} color=${workflowResultColor(row.result)}>
                  ${String(row.result).padEnd(10)} ${String(row.startedAt).padEnd(8)} ${String(row.duration).padEnd(9)} ${row.workflowName}
                <//>
              `)
            : html`<${Text} color=${ANSI_COLORS.muted}>No recent runs.<//>`}
        <//>
      <//>

      ${triggerTemplateId
        ? html`<${TriggerForm}
            template=${workflowState?.workflowMap?.get(triggerTemplateId) || selectedTemplate}
            formState=${triggerForm}
            activeFieldIndex=${triggerFieldIndex}
            onChange=${updateTriggerValue}
          />`
        : null}

      ${inspectingRunId && inspectingDetail
        ? html`<${WorkflowDetail}
            detail=${inspectingDetail.detail || inspectingDetail}
            expandedPaths=${expandedPaths}
            selectedTreePath=${selectedTreePath}
          />`
        : null}

      <${Box} marginTop=${1} borderStyle="single" paddingX=${1}>
        <${Text} dimColor>[↑↓] Navigate  [←→] Pane  [T] Trigger  [E] Enable  [I]/[Enter] Inspect  [C] Cancel run  [Space] Expand  [Del] Uninstall</${Text}>
      <//>
      ${statusLine ? html`<${Text} color="yellow">${statusLine}<//>` : null}
    <//>
  `;
}
