/**
 * workflow-templates/bosun-native.mjs — Bosun Native Tool & Workflow Templates
 *
 * Templates demonstrating:
 *   - Bosun tool invocation from workflows (action.bosun_tool)
 *   - Internal function calls (action.bosun_function)
 *   - Sub-workflow invocation with data piping (action.invoke_workflow)
 *   - Cross-workflow composition patterns
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ── Template 1: Bosun Tool Pipeline ─────────────────────────────────────────
// Demonstrates: List tools → Run tool → Extract results → Notify
// Pattern: Discover available tools, run one, extract structured data, log output

resetLayout();
export const BOSUN_TOOL_PIPELINE_TEMPLATE = {
  id: "template-bosun-tool-pipeline",
  name: "Bosun Tool Pipeline",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.manual",
  description:
    "Run Bosun built-in or custom tools from a workflow with structured " +
    "output piping. Discovers available tools, invokes a selected tool, " +
    "extracts specific data fields, and forwards them to downstream nodes. " +
    "Combines action.bosun_function and action.bosun_tool for full tool integration.",
  variables: {
    targetTool: "list-todos",
    toolArgs: "",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start"),

    // Step 1: List all available Bosun tools
    node("list-tools", "action.bosun_function", "List Available Tools", {
      function: "tools.list",
      outputVariable: "availableTools",
    }),

    // Step 2: Get details of the target tool
    node("get-tool-info", "action.bosun_function", "Get Tool Info", {
      function: "tools.get",
      args: { toolId: "{{targetTool}}" },
      outputVariable: "toolInfo",
    }),

    // Step 3: Check the tool exists before running
    node("tool-exists", "condition.expression", "Tool Exists?", {
      expression: "{{get-tool-info.found}}",
      trueLabel: "Found",
      falseLabel: "Not Found",
    }),

    // Step 4: Execute the Bosun tool
    node("run-tool", "action.bosun_tool", "Run Tool", {
      toolId: "{{targetTool}}",
      args: ["{{toolArgs}}"],
      parseJson: true,
      extract: {
        fields: {
          itemCount: "length",
          items: "[*]",
        },
        defaults: {
          itemCount: 0,
          items: [],
        },
        types: {
          itemCount: "number",
        },
      },
      outputVariable: "toolOutput",
    }),

    // Step 5: Log the results
    node("log-results", "notify.log", "Log Results", {
      message:
        "Tool Pipeline: Found {{list-tools.data.length}} tools. " +
        "Ran '{{targetTool}}': {{run-tool.itemCount}} results (exit {{run-tool.exitCode}})",
      level: "info",
    }),

    // Error path: tool not found
    node("log-not-found", "notify.log", "Tool Not Found", {
      message: "Tool '{{targetTool}}' not found. Available tools: {{list-tools.data.length}}",
      level: "warn",
    }),
  ],
  edges: [
    edge("trigger", "list-tools"),
    edge("list-tools", "get-tool-info"),
    edge("get-tool-info", "tool-exists"),
    edge("tool-exists", "run-tool", { port: "true" }),
    edge("tool-exists", "log-not-found", { port: "false" }),
    edge("run-tool", "log-results"),
  ],
  metadata: {
    author: "virtengine",
    tags: ["bosun", "tools", "pipeline", "structured-output"],
  },
};

// ── Template 2: Workflow Composition (Sub-Workflow Piping) ───────────────────
// Demonstrates: Trigger → Invoke Sub-Workflow → Extract Output → Continue
// Pattern: Compose complex workflows from smaller reusable workflows

resetLayout();
export const WORKFLOW_COMPOSITION_TEMPLATE = {
  id: "template-workflow-composition",
  name: "Workflow Composition",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.manual",
  description:
    "Compose workflows from smaller sub-workflows using action.invoke_workflow. " +
    "Demonstrates workflow-to-workflow data piping: the parent workflow invokes " +
    "a child workflow, extracts specific output fields, and forwards them to " +
    "downstream nodes. Supports both sync and dispatch modes.",
  variables: {
    childWorkflowId: "template-health-check",
    inputPayload: "{}",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start"),

    // Step 1: List available workflows to pick from
    node("list-workflows", "action.bosun_function", "List Workflows", {
      function: "workflows.list",
      outputVariable: "allWorkflows",
    }),

    // Step 2: Invoke the child workflow (sync — wait for result)
    node("invoke-child", "action.invoke_workflow", "Invoke Sub-Workflow", {
      workflowId: "{{childWorkflowId}}",
      input: "{{inputPayload}}",
      mode: "sync",
      timeout: 120000,
      failOnError: false,
      outputVariable: "childResult",
    }),

    // Step 3: Check child workflow success
    node("check-success", "condition.expression", "Success?", {
      expression: "{{invoke-child.success}}",
    }),

    // Step 4a: Process successful output
    node("process-output", "notify.log", "Process Output", {
      message:
        "Sub-workflow '{{childWorkflowId}}' succeeded. " +
        "Run ID: {{invoke-child.runId}}",
      level: "info",
    }),

    // Step 4b: Handle failure
    node("handle-failure", "notify.log", "Handle Failure", {
      message:
        "Sub-workflow '{{childWorkflowId}}' failed with {{invoke-child.errorCount}} error(s). " +
        "First error: {{invoke-child.errors}}",
      level: "error",
    }),
  ],
  edges: [
    edge("trigger", "list-workflows"),
    edge("list-workflows", "invoke-child"),
    edge("invoke-child", "check-success"),
    edge("check-success", "process-output", { port: "true" }),
    edge("check-success", "handle-failure", { port: "false" }),
  ],
  metadata: {
    author: "virtengine",
    tags: ["workflow", "composition", "sub-workflow", "piping", "orchestration"],
  },
};

// ── Template 3: MCP-to-Bosun Bridge ─────────────────────────────────────────
// Demonstrates: MCP Tool → Extract → Bosun Function → Sub-Workflow
// Pattern: External MCP data → Bosun internal actions → Workflow dispatch

resetLayout();
export const MCP_TO_BOSUN_BRIDGE_TEMPLATE = {
  id: "template-mcp-to-bosun-bridge",
  name: "MCP-to-Bosun Bridge",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.manual",
  description:
    "Bridge external MCP tools with Bosun internal capabilities. Calls an " +
    "MCP tool (e.g. GitHub), extracts structured data, creates Bosun tasks " +
    "from the results, and optionally dispatches sub-workflows for each item. " +
    "Full integration pattern: External Data → Internal Action → Workflow.",
  variables: {
    mcpServer: "github",
    mcpTool: "list_pull_requests",
    mcpInput: "{}",
    processingWorkflow: "",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start"),

    // Step 1: Call MCP tool for external data
    node("fetch-external", "action.mcp_tool_call", "Fetch External Data", {
      server: "{{mcpServer}}",
      tool: "{{mcpTool}}",
      input: "{{mcpInput}}",
      outputVariable: "externalData",
      extract: {
        fields: {
          items: "[*]",
          totalCount: "length",
          firstTitle: "[0].title",
        },
        defaults: {
          items: [],
          totalCount: 0,
          firstTitle: "N/A",
        },
        types: {
          totalCount: "number",
        },
      },
    }),

    // Step 2: Git status check (internal Bosun function)
    node("git-check", "action.bosun_function", "Check Git Status", {
      function: "git.status",
      outputVariable: "gitStatus",
    }),

    // Step 3: Create a summary task based on external data
    node("create-task", "action.bosun_function", "Create Summary Task", {
      function: "tasks.create",
      args: {
        title: "External data: {{fetch-external.totalCount}} items from {{mcpServer}}/{{mcpTool}}",
        description: "First item: {{fetch-external.firstTitle}}. Git clean: {{git-check.clean}}",
        priority: "medium",
        labels: ["mcp-bridge", "{{mcpServer}}"],
      },
    }),

    // Step 4: Optionally invoke a processing workflow
    node("has-processing-wf", "condition.expression", "Has Processing Workflow?", {
      expression: "{{processingWorkflow}}",
    }),

    node("dispatch-processing", "action.invoke_workflow", "Dispatch Processing", {
      workflowId: "{{processingWorkflow}}",
      input: {
        externalData: "{{fetch-external.data}}",
        itemCount: "{{fetch-external.totalCount}}",
        gitClean: "{{git-check.clean}}",
      },
      mode: "dispatch",
    }),

    node("log-complete", "notify.log", "Bridge Complete", {
      message:
        "MCP-to-Bosun bridge: {{fetch-external.totalCount}} items fetched, " +
        "task created, processing {{has-processing-wf.result}}",
      level: "info",
    }),
  ],
  edges: [
    edge("trigger", "fetch-external"),
    edge("fetch-external", "git-check"),
    edge("git-check", "create-task"),
    edge("create-task", "has-processing-wf"),
    edge("has-processing-wf", "dispatch-processing", { port: "true" }),
    edge("has-processing-wf", "log-complete", { port: "false" }),
    edge("dispatch-processing", "log-complete"),
  ],
  metadata: {
    author: "virtengine",
    tags: ["mcp", "bosun", "bridge", "tasks", "integration", "orchestration"],
  },
};

// ── Template 4: Git Health → Tool Analysis → Sub-Workflow ───────────────────
// Demonstrates: Bosun functions + tools + sub-workflow in one pipeline

resetLayout();
export const GIT_HEALTH_PIPELINE_TEMPLATE = {
  id: "template-git-health-pipeline",
  name: "Git Health Pipeline",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.schedule",
  description:
    "Automated git health check pipeline. Uses Bosun functions for git status " +
    "and branch info, runs the git-hot-files tool to identify churn hotspots, " +
    "and dispatches a cleanup workflow if issues are found. Full Bosun-native " +
    "orchestration pattern.",
  variables: {
    cleanupWorkflow: "template-health-check",
    churnThreshold: "10",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Scheduled", {
      cron: "0 6 * * 1",
    }),

    // Step 1: Check git status
    node("git-status", "action.bosun_function", "Git Status", {
      function: "git.status",
      outputVariable: "status",
    }),

    // Step 2: Get branch info
    node("git-branch", "action.bosun_function", "Branch Info", {
      function: "git.branch",
      outputVariable: "branches",
    }),

    // Step 3: Get recent commit log
    node("git-log", "action.bosun_function", "Recent Commits", {
      function: "git.log",
      args: { count: "20" },
      outputVariable: "recentCommits",
    }),

    // Step 4: Run git-hot-files tool for churn analysis
    node("hot-files", "action.bosun_tool", "Churn Analysis", {
      toolId: "git-hot-files",
      args: ["--days", "30", "--top", "20"],
      parseJson: true,
      extract: {
        fields: {
          hotFiles: "[*].file",
          maxChurn: "[0].commits",
        },
        defaults: {
          hotFiles: [],
          maxChurn: 0,
        },
        types: {
          maxChurn: "number",
        },
      },
      outputVariable: "churnData",
    }),

    // Step 5: Check if churn exceeds threshold
    node("churn-check", "condition.expression", "High Churn?", {
      expression: "{{hot-files.maxChurn}} > {{churnThreshold}}",
    }),

    // Step 6a: Dispatch cleanup workflow if high churn
    node("dispatch-cleanup", "action.invoke_workflow", "Dispatch Cleanup", {
      workflowId: "{{cleanupWorkflow}}",
      input: {
        hotFiles: "{{hot-files.hotFiles}}",
        maxChurn: "{{hot-files.maxChurn}}",
        currentBranch: "{{git-branch.current}}",
        changedFiles: "{{git-status.changedFiles}}",
      },
      mode: "sync",
      failOnError: false,
    }),

    // Step 6b: Log healthy status
    node("log-healthy", "notify.log", "Healthy", {
      message:
        "Git health OK: branch={{git-branch.current}}, " +
        "changed={{git-status.changedFiles}}, maxChurn={{hot-files.maxChurn}}",
      level: "info",
    }),
  ],
  edges: [
    edge("trigger", "git-status"),
    edge("git-status", "git-branch"),
    edge("git-branch", "git-log"),
    edge("git-log", "hot-files"),
    edge("hot-files", "churn-check"),
    edge("churn-check", "dispatch-cleanup", { port: "true" }),
    edge("churn-check", "log-healthy", { port: "false" }),
  ],
  metadata: {
    author: "virtengine",
    tags: ["git", "health", "churn", "tools", "sub-workflow", "automation"],
  },
};
