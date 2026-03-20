import { describe, it, expect } from "vitest";
import {
  sanitizeProjectName,
  generateCurlExamples,
  generateEnvTemplate,
  generateReadme,
  generateExportBundle,
} from "../workflow/workflow-exporter.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkflow(overrides = {}) {
  return {
    id: "wf-export-1",
    name: "Export Test Workflow",
    description: "A workflow for export tests",
    category: "testing",
    enabled: true,
    variables: {},
    nodes: [
      { id: "n1", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 } },
      { id: "n2", type: "action.http_request", label: "Fetch", config: { url: "https://example.com" }, position: { x: 100, y: 0 } },
    ],
    edges: [
      { source: "n1", target: "n2" },
    ],
    ...overrides,
  };
}

// ── sanitizeProjectName ─────────────────────────────────────────────────────

describe("sanitizeProjectName", () => {
  it("converts a normal name to kebab-case", () => {
    expect(sanitizeProjectName("My Cool Workflow")).toBe("my-cool-workflow");
  });

  it("strips special characters", () => {
    expect(sanitizeProjectName("PR Cleanup (v2)")).toBe("pr-cleanup-v2");
  });

  it("trims leading/trailing dashes", () => {
    expect(sanitizeProjectName("---hello---")).toBe("hello");
  });

  it("returns 'bosun-workflow' for empty/null input", () => {
    expect(sanitizeProjectName("")).toBe("bosun-workflow");
    expect(sanitizeProjectName(null)).toBe("bosun-workflow");
    expect(sanitizeProjectName(undefined)).toBe("bosun-workflow");
  });

  it("truncates to 64 characters", () => {
    const longName = "a".repeat(200);
    const result = sanitizeProjectName(longName);
    expect(result.length).toBeLessThanOrEqual(64);
  });

  it("handles numeric-only names", () => {
    expect(sanitizeProjectName("12345")).toBe("12345");
  });

  it("falls back for all-special-character names", () => {
    expect(sanitizeProjectName("!!!")).toBe("bosun-workflow");
  });
});

// ── generateCurlExamples ────────────────────────────────────────────────────

describe("generateCurlExamples", () => {
  it("generates a manual curl command", () => {
    const wf = makeWorkflow();
    const curls = generateCurlExamples(wf);

    expect(curls.manual).toContain("curl -X POST");
    expect(curls.manual).toContain("/api/workflows/wf-export-1/execute");
    expect(curls.manual).toContain("Content-Type: application/json");
  });

  it("uses custom baseUrl", () => {
    const wf = makeWorkflow();
    const curls = generateCurlExamples(wf, { baseUrl: "https://my-server.com" });
    expect(curls.manual).toContain("https://my-server.com");
  });

  it("returns empty webhook when no token provided", () => {
    const curls = generateCurlExamples(makeWorkflow());
    expect(curls.webhook).toBe("");
    expect(curls.webhookStream).toBe("");
  });

  it("generates webhook curl when token provided", () => {
    const curls = generateCurlExamples(makeWorkflow(), { webhookToken: "abc123" });
    expect(curls.webhook).toContain("/api/webhooks/wf-export-1/abc123");
    expect(curls.webhookStream).toContain("Webhook execution");
  });

  it("uses placeholder for workflow without id", () => {
    const wf = { ...makeWorkflow(), id: undefined };
    const curls = generateCurlExamples(wf);
    expect(curls.manual).toContain("<WORKFLOW_ID>");
  });
});

// ── generateEnvTemplate ─────────────────────────────────────────────────────

describe("generateEnvTemplate", () => {
  it("always includes server URL", () => {
    const env = generateEnvTemplate(makeWorkflow());
    expect(env).toContain("BOSUN_URL=");
  });

  it("detects GitHub credential hints", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "action.create_pr", label: "PR" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("GITHUB_TOKEN=");
  });

  it("detects Telegram credential hints", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "notify.telegram", label: "TG" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("TELEGRAM_BOT_TOKEN=");
    expect(env).toContain("TELEGRAM_CHAT_ID=");
  });

  it("detects LLM credential hints from config.model", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "action.custom", label: "AI", config: { model: "gpt-4" } }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("OPENAI_API_KEY=");
  });

  it("detects LLM credential hints from type containing 'llm'", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "action.llm_call", label: "LLM" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("OPENAI_API_KEY=");
  });

  it("detects MCP hints", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "action.mcp_tool_call", label: "MCP" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("MCP Servers");
  });

  it("detects web search hints", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "action.web_search", label: "Search" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("TAVILY_API_KEY=");
  });

  it("detects webhook out hints", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "notify.webhook_out", label: "Hook" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("WEBHOOK_URL=");
  });

  it("produces clean output for workflow with no credentials needed", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "trigger.manual", label: "Start" }],
    });
    const env = generateEnvTemplate(wf);
    expect(env).toContain("BOSUN_URL=");
    expect(env).not.toContain("GITHUB_TOKEN=");
    expect(env).not.toContain("TELEGRAM_BOT_TOKEN=");
  });
});

// ── generateReadme ──────────────────────────────────────────────────────────

describe("generateReadme", () => {
  it("contains the workflow name", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("# Export Test Workflow");
  });

  it("contains the description", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("A workflow for export tests");
  });

  it("contains node count and edge count", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("**Nodes:** 2");
    expect(readme).toContain("**Edges:** 1");
  });

  it("lists node types used", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("`trigger.manual`");
    expect(readme).toContain("`action.http_request`");
  });

  it("contains Quick Start instructions", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("Quick Start");
    expect(readme).toContain("bosun workflow import");
  });

  it("contains manual execution curl", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("curl -X POST");
  });

  it("includes webhook section when token provided", () => {
    const readme = generateReadme(makeWorkflow(), { webhookToken: "tok123" });
    expect(readme).toContain("Webhook Execution");
    expect(readme).toContain("tok123");
  });

  it("omits webhook section when no token", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).not.toContain("Webhook Execution");
  });

  it("includes files table", () => {
    const readme = generateReadme(makeWorkflow());
    expect(readme).toContain("workflow.json");
    expect(readme).toContain(".env.example");
    expect(readme).toContain("README.md");
  });

  it("handles workflow with no description", () => {
    const wf = makeWorkflow({ description: "" });
    const readme = generateReadme(wf);
    expect(readme).toContain("# Export Test Workflow");
  });
});

// ── generateExportBundle ────────────────────────────────────────────────────

describe("generateExportBundle", () => {
  it("returns all expected files", () => {
    const bundle = generateExportBundle(makeWorkflow());

    expect(bundle.projectName).toBe("export-test-workflow");
    expect(bundle.files.length).toBeGreaterThanOrEqual(4); // workflow.json, README, .env, examples/execute.sh

    const paths = bundle.files.map(f => f.path);
    expect(paths).toContain("workflow.json");
    expect(paths).toContain("README.md");
    expect(paths).toContain(".env.example");
    expect(paths).toContain("examples/execute.sh");
  });

  it("includes webhook example when token provided", () => {
    const bundle = generateExportBundle(makeWorkflow(), { webhookToken: "whk" });
    const paths = bundle.files.map(f => f.path);
    expect(paths).toContain("examples/webhook.sh");
  });

  it("workflow.json contains valid JSON", () => {
    const bundle = generateExportBundle(makeWorkflow());
    const wfFile = bundle.files.find(f => f.path === "workflow.json");
    const parsed = JSON.parse(wfFile.content);
    expect(parsed.name).toBe("Export Test Workflow");
  });

  it("returns correct metadata", () => {
    const bundle = generateExportBundle(makeWorkflow());
    expect(bundle.metadata.nodeCount).toBe(2);
    expect(bundle.metadata.edgeCount).toBe(1);
    expect(typeof bundle.metadata.exportedAt).toBe("number");
    expect(bundle.metadata.workflowId).toBe("wf-export-1");
    expect(bundle.metadata.workflowName).toBe("Export Test Workflow");
  });

  it("works with minimal workflow (no nodes/edges)", () => {
    const wf = { name: "Minimal" };
    const bundle = generateExportBundle(wf);

    expect(bundle.projectName).toBe("minimal");
    expect(bundle.metadata.nodeCount).toBe(0);
    expect(bundle.metadata.edgeCount).toBe(0);

    const wfFile = bundle.files.find(f => f.path === "workflow.json");
    const parsed = JSON.parse(wfFile.content);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.edges).toEqual([]);
  });

  it("throws on null input", () => {
    expect(() => generateExportBundle(null)).toThrow("Invalid workflow");
  });

  it("throws on non-object input", () => {
    expect(() => generateExportBundle("string")).toThrow("Invalid workflow");
  });

  it("execute.sh starts with shebang", () => {
    const bundle = generateExportBundle(makeWorkflow());
    const execFile = bundle.files.find(f => f.path === "examples/execute.sh");
    expect(execFile.content.startsWith("#!/usr/bin/env bash")).toBe(true);
  });
});
