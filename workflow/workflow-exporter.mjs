/**
 * workflow-exporter.mjs — Workflow export bundle generation
 *
 * Generates downloadable workflow packages including:
 * - workflow.json (the workflow definition)
 * - README.md (setup + usage instructions)
 * - .env.example (required environment variables)
 * - examples/ (cURL commands for webhook/manual execution)
 */

import { serializeWorkflowToCode } from "./workflow-serializer.mjs";

/**
 * Sanitize a workflow name into a valid project/folder name.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeProjectName(name) {
  return String(name || "bosun-workflow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    || "bosun-workflow";
}

/**
 * Generate cURL examples for a workflow.
 * @param {object} workflow - The workflow
 * @param {object} opts - { baseUrl, webhookToken }
 * @returns {{ manual: string, webhook: string, webhookStream: string }}
 */
export function generateCurlExamples(workflow, opts = {}) {
  const baseUrl = opts.baseUrl || "http://localhost:3077";
  const workflowId = workflow.id || "<WORKFLOW_ID>";

  const manual = [
    `curl -X POST "${baseUrl}/api/workflows/${workflowId}/execute" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({ inputs: {} })}'`,
  ].join("\n");

  let webhook = "";
  let webhookStream = "";

  if (opts.webhookToken) {
    webhook = [
      `curl -X POST "${baseUrl}/api/webhooks/${workflowId}/${opts.webhookToken}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${JSON.stringify({ payload: { key: "value" } })}'`,
    ].join("\n");

    webhookStream = [
      `# Webhook execution (same endpoint, payload forwarded to workflow)`,
      webhook,
    ].join("\n");
  }

  return { manual, webhook, webhookStream };
}

/**
 * Generate an environment variable template for a workflow.
 * @param {object} workflow - The workflow
 * @returns {string}
 */
export function generateEnvTemplate(workflow) {
  const lines = [
    "# Bosun Workflow Environment Variables",
    `# Generated for: ${workflow.name || "Untitled Workflow"}`,
    `# Date: ${new Date().toISOString().split("T")[0]}`,
    "",
    "# Bosun Server",
    "BOSUN_URL=http://localhost:3077",
    "",
  ];

  // Scan nodes for common credential patterns
  const nodes = workflow.nodes || [];
  const credentialHints = new Set();

  for (const node of nodes) {
    const type = node.type || "";
    const config = node.config || {};

    if (type === "action.mcp_tool_call" || type === "action.mcp_pipeline") {
      credentialHints.add("MCP");
    }
    if (type === "action.web_search") {
      credentialHints.add("WEB_SEARCH");
    }
    if (type === "notify.telegram") {
      credentialHints.add("TELEGRAM");
    }
    if (type === "notify.webhook_out") {
      credentialHints.add("WEBHOOK_OUT");
    }
    if (type === "action.create_pr" || type === "action.git_operations") {
      credentialHints.add("GITHUB");
    }
    if (config.model || config.llmModel || type.includes("llm") || type.includes("agent")) {
      credentialHints.add("LLM");
    }
  }

  if (credentialHints.has("GITHUB")) {
    lines.push("# GitHub Access", "GITHUB_TOKEN=", "");
  }
  if (credentialHints.has("TELEGRAM")) {
    lines.push("# Telegram Bot", "TELEGRAM_BOT_TOKEN=", "TELEGRAM_CHAT_ID=", "");
  }
  if (credentialHints.has("LLM")) {
    lines.push("# LLM Provider", "OPENAI_API_KEY=", "# ANTHROPIC_API_KEY=", "");
  }
  if (credentialHints.has("MCP")) {
    lines.push("# MCP Servers are configured in bosun.config.json", "");
  }
  if (credentialHints.has("WEB_SEARCH")) {
    lines.push("# Web Search", "TAVILY_API_KEY=", "");
  }
  if (credentialHints.has("WEBHOOK_OUT")) {
    lines.push("# Outbound Webhook URLs", "WEBHOOK_URL=", "");
  }

  return lines.join("\n");
}

/**
 * Generate a README.md for an exported workflow.
 * @param {object} workflow
 * @param {object} opts - { baseUrl, webhookToken, projectName }
 * @returns {string}
 */
export function generateReadme(workflow, opts = {}) {
  const projectName = opts.projectName || sanitizeProjectName(workflow.name);
  const curls = generateCurlExamples(workflow, opts);

  const lines = [
    `# ${workflow.name || "Bosun Workflow"}`,
    "",
    workflow.description ? `${workflow.description}\n` : "",
    "## Quick Start",
    "",
    "1. Import this workflow into Bosun:",
    "   ```bash",
    `   bosun workflow import workflow.json`,
    "   ```",
    "",
    "2. Or place `workflow.json` in your Bosun config directory.",
    "",
    "3. Configure environment variables (see `.env.example`).",
    "",
    "## Manual Execution",
    "",
    "```bash",
    curls.manual,
    "```",
    "",
  ];

  if (curls.webhook) {
    lines.push(
      "## Webhook Execution",
      "",
      "```bash",
      curls.webhook,
      "```",
      "",
    );
  }

  lines.push(
    "## Workflow Structure",
    "",
    `- **Nodes:** ${(workflow.nodes || []).length}`,
    `- **Edges:** ${(workflow.edges || []).length}`,
    `- **Category:** ${workflow.category || "custom"}`,
    "",
    "### Node Types Used",
    "",
  );

  const typeFreq = {};
  for (const n of (workflow.nodes || [])) {
    const t = n.type || "unknown";
    typeFreq[t] = (typeFreq[t] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeFreq).sort()) {
    lines.push(`- \`${type}\` × ${count}`);
  }

  lines.push(
    "",
    "## Files",
    "",
    "| File | Description |",
    "|---|---|",
    "| `workflow.json` | The workflow definition (import into Bosun) |",
    "| `.env.example` | Required environment variables |",
    "| `README.md` | This file |",
    "",
    "---",
    "",
    `Exported from Bosun on ${new Date().toISOString().split("T")[0]}`,
  );

  return lines.join("\n");
}

/**
 * Generate a complete export bundle for a workflow.
 * Returns a list of files with their contents (for zip generation or API response).
 *
 * @param {object} workflow - The workflow object
 * @param {object} opts - { baseUrl, webhookToken }
 * @returns {{ projectName: string, files: Array<{ path: string, content: string }>, metadata: object }}
 */
export function generateExportBundle(workflow, opts = {}) {
  if (!workflow || typeof workflow !== "object") {
    throw new Error("Invalid workflow: expected an object");
  }

  const projectName = sanitizeProjectName(workflow.name);
  const serialized = serializeWorkflowToCode(workflow);
  const readme = generateReadme(workflow, { ...opts, projectName });
  const envTemplate = generateEnvTemplate(workflow);
  const curls = generateCurlExamples(workflow, opts);

  const files = [
    { path: "workflow.json", content: serialized.code },
    { path: "README.md", content: readme },
    { path: ".env.example", content: envTemplate },
  ];

  // Add cURL example files
  if (curls.manual) {
    files.push({ path: "examples/execute.sh", content: `#!/usr/bin/env bash\n# Execute workflow manually\n${curls.manual}\n` });
  }
  if (curls.webhook) {
    files.push({ path: "examples/webhook.sh", content: `#!/usr/bin/env bash\n# Trigger workflow via webhook\n${curls.webhook}\n` });
  }

  return {
    projectName,
    files,
    metadata: {
      ...serialized.metadata,
      exportedAt: Date.now(),
      workflowId: workflow.id || null,
      workflowName: workflow.name || "Untitled",
    },
  };
}
