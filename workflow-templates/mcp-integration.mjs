/**
 * workflow-templates/mcp-integration.mjs — MCP Tool Integration Templates
 *
 * Templates demonstrating MCP tool → workflow integration:
 *   - MCP Tool Chain: Multi-tool pipeline with data extraction & piping
 *   - MCP GitHub PR Monitor: GitHub PRs → extract → notify
 *   - MCP Research Pipeline: Context7 docs → web search → aggregate
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ── Template 1: MCP Tool Chain ──────────────────────────────────────────────
// Demonstrates: mcp_list_tools → mcp_tool_call with extraction → mcp_extract → notify
// Pattern: Discover tools → Call tool → Extract fields → Forward to notification

resetLayout();
export const MCP_TOOL_CHAIN_TEMPLATE = {
  id: "template-mcp-tool-chain",
  name: "MCP Tool Chain",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.manual",
  description:
    "Chain MCP tools together with structured data extraction. Discovers " +
    "available tools on a server, calls a selected tool, extracts specific " +
    "data fields from the output, and forwards them to downstream nodes. " +
    "Demonstrates the full MCP-to-workflow data piping pattern.",
  variables: {
    mcpServer: "github",
    toolName: "list_pull_requests",
    toolInput: "{}",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start", {}),

    // Step 1: Discover what tools are available
    node("discover-tools", "action.mcp_list_tools", "Discover MCP Tools", {
      server: "{{mcpServer}}",
      outputVariable: "availableTools",
      includeSchemas: true,
    }),

    // Step 2: Call the actual MCP tool with structured extraction
    node("call-tool", "action.mcp_tool_call", "Call MCP Tool", {
      server: "{{mcpServer}}",
      tool: "{{toolName}}",
      input: "{{toolInput}}",
      outputVariable: "toolResult",
      // Extract specific fields from the MCP response
      extract: {
        fields: {
          itemCount: "length",
          firstItem: "[0]",
          allTitles: "[*].title",
        },
        defaults: {
          itemCount: 0,
          firstItem: null,
          allTitles: [],
        },
        types: {
          itemCount: "number",
          allTitles: "array",
        },
      },
    }),

    // Step 3: Transform & extract deeper data
    node("extract-data", "transform.mcp_extract", "Extract Data Points", {
      source: "call-tool",
      sourceField: "data",
      fields: {
        totalItems: "length",
        summary: "[0].title",
      },
      defaults: {
        totalItems: 0,
        summary: "No items found",
      },
      types: {
        totalItems: "number",
        summary: "string",
      },
    }),

    // Step 4: Log the results
    node("log-results", "notify.log", "Log Results", {
      message:
        "MCP Pipeline: {{discover-tools.toolCount}} tools available, " +
        "{{call-tool.itemCount}} items returned, first: {{extract-data.summary}}",
      level: "info",
    }),
  ],
  edges: [
    edge("trigger", "discover-tools"),
    edge("discover-tools", "call-tool"),
    edge("call-tool", "extract-data"),
    edge("extract-data", "log-results"),
  ],
  metadata: {
    author: "virtengine",
    tags: ["mcp", "integration", "pipeline", "data-extraction"],
  },
};

// ── Template 2: MCP GitHub PR Monitor ───────────────────────────────────────
// Pattern: GitHub MCP → extract PR data → conditional routing → notification

resetLayout();
export const MCP_GITHUB_PR_MONITOR_TEMPLATE = {
  id: "template-mcp-github-pr-monitor",
  name: "MCP GitHub PR Monitor",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.schedule",
  description:
    "Periodically fetches open PRs from GitHub via MCP, extracts PR metadata " +
    "(titles, authors, labels, review status), routes based on PR count, " +
    "and sends notifications. Demonstrates MCP → extract → condition → notify.",
  variables: {
    owner: "virtengine",
    repo: "bosun",
    checkInterval: "*/30 * * * *",
    prThreshold: 5,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check PRs", {
      schedule: "{{checkInterval}}",
    }),

    // Fetch PRs from GitHub MCP
    node("fetch-prs", "action.mcp_tool_call", "Fetch Open PRs", {
      server: "github",
      tool: "list_pull_requests",
      input: {
        owner: "{{owner}}",
        repo: "{{repo}}",
        state: "open",
      },
      outputVariable: "prData",
      // Extract structured PR data
      extract: {
        fields: {
          prCount: "length",
          prTitles: "[*].title",
          prAuthors: "[*].user.login",
          prNumbers: "[*].number",
          oldestPr: "[0].created_at",
          newestPr: "[-1].created_at",
        },
        defaults: { prCount: 0, prTitles: [], prAuthors: [] },
        types: { prCount: "number", prTitles: "array", prAuthors: "array", prNumbers: "array" },
      },
      // Route based on PR count
      portConfig: {
        field: "prCount",
        map: { "0": "none" },
        default: "has_prs",
      },
    }),

    // Conditional: many PRs → high-priority path
    node("check-threshold", "condition.expression", "Too Many PRs?", {
      expression: "$output.prCount >= $data.prThreshold",
    }),

    // Log for normal count
    node("log-normal", "notify.log", "PR Count Normal", {
      message: "{{fetch-prs.prCount}} open PRs — within threshold",
      level: "info",
    }),

    // Alert for high count
    node("alert-high", "notify.log", "PR Count High", {
      message:
        "⚠️ {{fetch-prs.prCount}} open PRs (threshold: {{prThreshold}}). " +
        "Authors: {{fetch-prs.prAuthors}}. Oldest: {{fetch-prs.oldestPr}}",
      level: "warn",
    }),
  ],
  edges: [
    edge("trigger", "fetch-prs"),
    edge("fetch-prs", "check-threshold"),
    edge("check-threshold", "log-normal", { port: "false" }),
    edge("check-threshold", "alert-high", { port: "true" }),
  ],
  metadata: {
    author: "virtengine",
    tags: ["mcp", "github", "monitoring", "pr"],
  },
};

// ── Template 3: MCP Pipeline — Cross-Server Data Flow ───────────────────────
// Pattern: Server A tool → extract → Server B tool → extract → final output
// Demonstrates action.mcp_pipeline with real cross-server piping

resetLayout();
export const MCP_CROSS_SERVER_PIPELINE_TEMPLATE = {
  id: "template-mcp-cross-server-pipeline",
  name: "MCP Cross-Server Pipeline",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.manual",
  description:
    "Execute a multi-step pipeline that chains tools across different MCP " +
    "servers. For example: GitHub PRs → extract data → Context7 docs lookup → " +
    "aggregate results. Demonstrates action.mcp_pipeline with inputMap piping.",
  variables: {
    githubOwner: "virtengine",
    githubRepo: "bosun",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start Pipeline", {}),

    // Single pipeline node that chains 3 MCP tool calls
    node("pipeline", "action.mcp_pipeline", "MCP Pipeline", {
      outputVariable: "pipelineResult",
      steps: [
        {
          id: "get-prs",
          server: "github",
          tool: "list_pull_requests",
          input: {
            owner: "{{githubOwner}}",
            repo: "{{githubRepo}}",
            state: "open",
          },
          extract: {
            fields: {
              prCount: "length",
              firstPrTitle: "[0].title",
              firstPrBody: "[0].body",
            },
            types: { prCount: "number" },
          },
          continueOnError: true,
        },
        {
          id: "lookup-docs",
          server: "context7",
          tool: "resolve-library-id",
          inputMap: {
            // Pipe data from previous step's extracted output
            libraryName: { _literal: "express" },
          },
          continueOnError: true,
        },
        {
          id: "search-web",
          server: "exa",
          tool: "web_search_exa",
          inputMap: {
            query: {
              _template: "{{githubRepo}} open pull requests best practices",
            },
          },
          extract: {
            fields: {
              resultCount: "results.length",
              topResult: "results[0].title",
            },
          },
          continueOnError: true,
        },
      ],
    }),

    // Aggregate and report results
    node("report", "notify.log", "Pipeline Report", {
      message:
        "Pipeline complete: {{pipeline.completedSteps}}/{{pipeline.stepCount}} steps succeeded. " +
        "Final output type: {{pipeline.finalOutput.contentType}}",
      level: "info",
    }),
  ],
  edges: [
    edge("trigger", "pipeline"),
    edge("pipeline", "report"),
  ],
  metadata: {
    author: "virtengine",
    tags: ["mcp", "pipeline", "cross-server", "data-flow"],
  },
};

// ── Template 4: MCP Iterative Research ──────────────────────────────────────
// Pattern: Loop over items → call MCP tool per item → aggregate results

resetLayout();
export const MCP_ITERATIVE_RESEARCH_TEMPLATE = {
  id: "template-mcp-iterative-research",
  name: "MCP Iterative Research",
  category: "mcp-integration",
  enabled: true,
  trigger: "trigger.workflow_call",
  description:
    "Accepts a list of topics, iterates over them, calls an MCP tool for each, " +
    "extracts structured results, and aggregates everything. Shows how to " +
    "combine loop.for_each with MCP tool calls for batch processing.",
  variables: {
    topics: '["node.js best practices", "typescript generics", "vitest testing"]',
    mcpServer: "context7",
    mcpTool: "resolve-library-id",
    topic: "",
  },
  nodes: [
    node("trigger", "trigger.workflow_call", "Research Request", {}),

    // Parse topics list
    node("parse-topics", "transform.json_parse", "Parse Topics", {
      value: "{{topics}}",
    }),

    // Iterate over topics
    node("loop", "loop.for_each", "For Each Topic", {
      items: "$data.parse_topics?.data || []",
      variable: "topic",
      maxIterations: 20,
    }),

    // Call MCP tool for each topic
    node("research", "action.mcp_tool_call", "Research Topic", {
      server: "{{mcpServer}}",
      tool: "{{mcpTool}}",
      input: { libraryName: "{{topic}}" },
      extract: {
        fields: {
          libraryId: "id",
          libraryName: "name",
          description: "description",
        },
      },
      continueOnError: true,
    }),

    // Aggregate results
    node("aggregate", "transform.aggregate", "Aggregate Results", {
      sources: ["research"],
    }),

    // Report
    node("report", "notify.log", "Research Complete", {
      message: "Research pipeline completed. Topics processed: {{parse-topics.data.length}}",
      level: "info",
    }),
  ],
  edges: [
    edge("trigger", "parse-topics"),
    edge("parse-topics", "loop"),
    edge("loop", "research"),
    edge("research", "aggregate"),
    edge("aggregate", "report"),
  ],
  metadata: {
    author: "virtengine",
    tags: ["mcp", "research", "iteration", "batch"],
  },
};
