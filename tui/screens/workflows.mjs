import React from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;

const html = htm.bind(React.createElement);

function truncate(value, width = 60) {
  const text = String(value || "");
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function formatEventTime(value) {
  if (!value) return "--:--:--";
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "--:--:--";
  }
}

function eventTone(status = "", eventType = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const normalizedType = String(eventType || "").trim().toLowerCase();
  if (normalizedStatus === "failed" || normalizedType.includes("error")) return "red";
  if (normalizedStatus === "running" || normalizedType.includes("start")) return "yellow";
  if (normalizedStatus === "completed" || normalizedType.includes("complete") || normalizedType.includes("end")) return "green";
  return undefined;
}

export default function WorkflowsScreen({ workflowsState, workflowEvents = [], stats = {} }) {
  const workflows = Array.isArray(workflowsState?.workflows) ? workflowsState.workflows : [];
  const loading = Boolean(workflowsState?.loading);
  const error = workflowsState?.error ? String(workflowsState.error) : "";
  const activeWorkflowRuns = Array.isArray(stats?.workflows?.active) ? stats.workflows.active : [];
  const totalWorkflows = Number(stats?.workflows?.total || workflows.length || 0);

  return html`
    <${Box} flexDirection="column" paddingY=${1} paddingX=${1}>
      <${Box} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Workflow Snapshot<//>
        <${Text}>Configured: ${workflows.length}${loading ? " (loading)" : ""}<//>
        <${Text}>Active Runs: ${activeWorkflowRuns.length}/${totalWorkflows}<//>
        ${error ? html`<${Text} color="red">${error}<//>` : null}
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Configured Workflows<//>
        ${workflows.length
          ? workflows.slice(0, 12).map((workflow) => html`
              <${Text} key=${workflow.id || workflow.name}>
                ${truncate(workflow.name || workflow.id || "workflow", 32).padEnd(34, " ")}
                ${String(workflow.enabled === false ? "disabled" : "enabled").padEnd(9, " ")}
                ${truncate(workflow.source || workflow.file || "configured", 34)}
              <//>
            `)
          : html`<${Text} dimColor>No workflows loaded yet.<//>`}
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Workflow Event Timeline<//>
        ${workflowEvents.length
          ? workflowEvents.slice(0, 10).map((event, index) => html`
              <${Text}
                key=${event.id || `${event.workflowId || "wf"}-${event.runId || "run"}-${index}`}
                color=${eventTone(event.status, event.eventType)}
              >
                ${formatEventTime(event.timestamp || event.at || event.createdAt)}
                ${"  "}
                ${truncate(event.workflowName || event.workflowId || "workflow", 24).padEnd(26, " ")}
                ${truncate(event.eventType || event.status || "event", 18).padEnd(20, " ")}
                ${truncate(event.error || event.message || event.nodeLabel || event.nodeId || "-", 56)}
              <//>
            `)
          : html`<${Text} dimColor>No workflow status events streamed yet.<//>`}
      <//>
    <//>
  `;
}
