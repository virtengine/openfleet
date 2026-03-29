/**
 * workflow-nodes.mjs — Built-in Workflow Node Types for Bosun
 *
 * Registers all standard node types that can be used in workflow definitions.
 * Node types are organized by category:
 *
 *   TRIGGERS    — Events that start workflow execution
 *   CONDITIONS  — Branching logic / gates
 *   ACTIONS     — Side-effect operations (run agent, create task, etc.)
 *   VALIDATION  — Verification gates (screenshots, tests, model review)
 *   TRANSFORM   — Data transformation / aggregation
 *   NOTIFY      — Notifications (telegram, log, etc.)
 *
 * Each node type must export:
 *   execute(node, ctx, engine) → Promise<any>   — The node's logic
 *   describe() → string                         — Human-readable description
 *   schema → object                             — JSON Schema for node config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, findRelevantSkills } from "../../agent/bosun-skills.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";

import {
  registerNodeType,
  BOSUN_ATTACHED_PR_LABEL,
  PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND,
  PORTABLE_WORKTREE_COUNT_COMMAND,
  TAG,
  WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT,
  WORKFLOW_AGENT_HEARTBEAT_MS,
  WORKFLOW_TELEGRAM_ICON_MAP,
  bindTaskContext,
  buildAgentEventPreview,
  buildAgentExecutionDigest,
  buildGitExecutionEnv,
  buildTaskContextBlock,
  buildWorkflowAgentToolContract,
  collectWakePhraseCandidates,
  condenseAgentItems,
  createKanbanTaskWithProject,
  decodeWorkflowUnicodeIconToken,
  deriveManagedWorktreeDirName,
  detectWakePhraseMatch,
  execGitArgsSync,
  extractStreamText,
  extractSymbolHint,
  formatAttachmentLine,
  formatCommentLine,
  getPathValue,
  isBosunStateComment,
  isManagedBosunWorktree,
  makeIsolatedGitEnv,
  normalizeLegacyWorkflowCommand,
  normalizeLineEndings,
  normalizeNarrativeText,
  normalizeTaskAttachments,
  normalizeTaskComments,
  normalizeWorkflowStack,
  normalizeWorkflowTelegramText,
  parseBooleanSetting,
  parsePathListingLine,
  resolveGitCandidates,
  resolveWorkflowNodeValue,
  simplifyPathLabel,
  summarizeAgentStreamEvent,
  summarizeAssistantMessageData,
  summarizeAssistantUsage,
  summarizePathListingBlock,
  trimLogText,
} from "./definitions.mjs";

registerNodeType("validation.screenshot", {
  describe: () => "Take a screenshot for visual verification and store in evidence",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to screenshot (local dev server, etc.)" },
      outputDir: { type: "string", default: ".bosun/evidence", description: "Directory to save screenshots" },
      filename: { type: "string", description: "Screenshot filename (auto-generated if empty)" },
      fullPage: { type: "boolean", default: true },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number", default: 1280 },
          height: { type: "number", default: 720 },
        },
      },
      waitMs: { type: "number", default: 2000, description: "Wait time before screenshot" },
    },
    required: ["url"],
  },
  async execute(node, ctx) {
    const url = ctx.resolve(node.config?.url || "http://localhost:3000");
    const outDir = ctx.resolve(node.config?.outputDir || ".bosun/evidence");
    const filename = ctx.resolve(node.config?.filename || `screenshot-${Date.now()}.png`);
    const fullPage = node.config?.fullPage !== false;
    const viewport = node.config?.viewport || { width: 1280, height: 720 };
    const waitMs = node.config?.waitMs || 2000;

    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, filename);

    ctx.log(node.id, `Taking screenshot of ${url}`);

    // Try multiple screenshot methods in order of preference
    // 1. Playwright (if available)
    // 2. Puppeteer (if available)
    // 3. Agent-based (ask agent to take screenshot via MCP)
    // 4. Fallback: generate a placeholder and note for manual

    const screenshotMethods = [
      {
        name: "playwright",
        test: () => {
          try { execSync("npx playwright --version", { stdio: "pipe", timeout: 10000 }); return true; } catch { return false; }
        },
        exec: () => {
          const script = `
            const { chromium } = require('playwright');
            (async () => {
              const browser = await chromium.launch({ headless: true });
              const page = await browser.newPage({ viewport: { width: ${viewport.width}, height: ${viewport.height} } });
              await page.goto('${url}', { waitUntil: 'networkidle' });
              await page.waitForTimeout(${waitMs});
              await page.screenshot({ path: '${outPath.replace(/\\/g, "\\\\")}', fullPage: ${fullPage} });
              await browser.close();
            })();
          `;
          const escapedScript = script
            .replace(/\n/g, " ")
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
          execSync(`node -e "${escapedScript}"`, {
            timeout: 60000,
            stdio: "pipe",
          });
        },
      },
      {
        name: "mcp-devtools",
        test: () => true, // always available as a prompt option
        exec: () => {
          // This will be executed by the agent via MCP chrome devtools
          ctx.data._pendingScreenshots = ctx.data._pendingScreenshots || [];
          ctx.data._pendingScreenshots.push({
            url,
            outPath,
            viewport,
            fullPage,
            waitMs,
          });
          // Write metadata file for the agent to process
          writeFileSync(
            resolve(outDir, `${filename}.meta.json`),
            JSON.stringify({ url, viewport, fullPage, waitMs, createdAt: Date.now() }, null, 2),
            "utf8"
          );
        },
      },
    ];

    let method = "none";
    for (const m of screenshotMethods) {
      try {
        if (m.test()) {
          m.exec();
          method = m.name;
          break;
        }
      } catch (err) {
        ctx.log(node.id, `Screenshot method ${m.name} failed: ${err.message}`, "warn");
      }
    }

    return {
      success: true,
      screenshotPath: outPath,
      method,
      url,
      viewport,
    };
  },
});

registerNodeType("validation.model_review", {
  describe: () => "Send evidence (screenshots, code, logs) to a non-agent model for independent verification",
  schema: {
    type: "object",
    properties: {
      evidenceDir: { type: "string", default: ".bosun/evidence", description: "Directory with evidence files" },
      originalTask: { type: "string", description: "Original task description for context" },
      criteria: { type: "string", description: "Specific acceptance criteria to verify" },
      model: { type: "string", default: "auto", description: "Model to use for review" },
      strictMode: { type: "boolean", default: true, description: "Require explicit PASS to succeed" },
    },
    required: ["originalTask"],
  },
  async execute(node, ctx, engine) {
    const evidenceDir = ctx.resolve(node.config?.evidenceDir || ".bosun/evidence");
    const originalTask = ctx.resolve(node.config?.originalTask || "");
    const criteria = ctx.resolve(node.config?.criteria || "");
    const strictMode = node.config?.strictMode !== false;

    ctx.log(node.id, `Model review: checking evidence in ${evidenceDir}`);

    // Collect evidence files
    const evidenceFiles = [];
    if (existsSync(evidenceDir)) {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(evidenceDir);
      for (const file of files) {
        if (file.endsWith(".meta.json")) continue;
        const filePath = resolve(evidenceDir, file);
        evidenceFiles.push({
          name: file,
          path: filePath,
          type: file.endsWith(".png") || file.endsWith(".jpg") ? "image" : "text",
        });
      }
    }

    if (evidenceFiles.length === 0) {
      ctx.log(node.id, "No evidence files found", "warn");
      return { passed: false, reason: "no_evidence", evidenceCount: 0 };
    }

    // Build the review prompt
    const reviewPrompt = `# Task Verification Review

## Original Task
${originalTask}

${criteria ? `## Acceptance Criteria\n${criteria}\n` : ""}

## Evidence Files
${evidenceFiles.map((f) => `- ${f.name} (${f.type})`).join("\n")}

## Instructions
Review the provided evidence (screenshots, code changes, logs) against the original task requirements.

Provide your assessment:
1. Does the implementation match the task requirements?
2. Are there any visual/functional issues visible in the screenshots?
3. Is the implementation complete or are there missing pieces?

## Verdict
Respond with exactly one of:
- **PASS** — Implementation meets all requirements
- **FAIL** — Implementation has issues (explain what's wrong)
- **PARTIAL** — Some requirements met but not all (explain what's missing)
`;

    // Use the agent pool for a non-agent model review
    const agentPool = engine.services?.agentPool;
    if (agentPool?.launchEphemeralThread) {
      const result = await agentPool.launchEphemeralThread(
        reviewPrompt,
        process.cwd(),
        5 * 60 * 1000, // 5-minute timeout for review
        { images: evidenceFiles.filter((f) => f.type === "image").map((f) => f.path) }
      );

      const output = result.output || "";
      const passed = strictMode
        ? /\bPASS\b/i.test(output) && !/\bFAIL\b/i.test(output)
        : !/\bFAIL\b/i.test(output);

      // Save review result
      const reviewPath = resolve(evidenceDir, `review-${Date.now()}.json`);
      writeFileSync(
        reviewPath,
        JSON.stringify({
          passed,
          originalTask,
          criteria,
          evidenceFiles: evidenceFiles.map((f) => f.name),
          reviewOutput: output,
          model: result.sdk,
          timestamp: Date.now(),
        }, null, 2),
        "utf8"
      );

      return {
        passed,
        reviewOutput: output,
        evidenceCount: evidenceFiles.length,
        reviewPath,
      };
    }

    // Fallback: mark for manual review
    ctx.log(node.id, "Agent pool not available for model review — marking for manual review", "warn");
    return {
      passed: false,
      reason: "manual_review_required",
      evidenceCount: evidenceFiles.length,
      evidenceDir,
    };
  },
});

registerNodeType("validation.tests", {
  describe: () => "Run test suite and verify results",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm test", description: "Test command to run" },
      cwd: { type: "string", description: "Working directory" },
      timeoutMs: { type: "number", default: 600000 },
      requiredPassRate: { type: "number", default: 1.0, description: "Minimum pass rate (0-1)" },
    },
  },
  async execute(node, ctx) {
    const command = ctx.resolve(node.config?.command || "npm test");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const resolvedTimeout = Number(ctx.resolve(node.config?.timeoutMs ?? 600000));
    const timeout = Number.isFinite(resolvedTimeout) && resolvedTimeout > 0
      ? Math.round(resolvedTimeout)
      : 600000;

    ctx.log(node.id, `Running tests: ${command}`);
    try {
      const useShell = /^(?:npm|pnpm|yarn|bun)(?:\s|$)/i.test(String(command || "").trim());
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
        ...(useShell ? { shell: true } : {}),
      });
      ctx.log(node.id, "Tests passed");
      return { passed: true, output: output?.trim() };
    } catch (err) {
      const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
      ctx.log(node.id, "Tests failed", "error");
      return { passed: false, output, exitCode: err.status };
    }
  },
});

registerNodeType("validation.build", {
  describe: () => "Run build and verify it succeeds with 0 errors",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm run build", description: "Build command" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", default: 600000 },
      zeroWarnings: { type: "boolean", default: false, description: "Fail on warnings too" },
    },
  },
  async execute(node, ctx) {
    const resolvedCommand = ctx.resolve(node.config?.command || "npm run build");
    const command = normalizeLegacyWorkflowCommand(resolvedCommand);
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 600000;

    if (command !== resolvedCommand) {
      ctx.log(node.id, `Normalized legacy command for portability: ${command}`);
    }
    ctx.log(node.id, `Building: ${command}`);
    try {
      const useShell = /^(?:npm|pnpm|yarn|bun)(?:\s|$)/i.test(String(command || "").trim());
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
        ...(useShell ? { shell: true } : {}),
      });
      const hasWarnings = /warning/i.test(output || "");
      if (node.config?.zeroWarnings && hasWarnings) {
        return { passed: false, reason: "warnings_found", output: output?.trim() };
      }
      return { passed: true, output: output?.trim() };
    } catch (err) {
      return { passed: false, output: err.stderr?.toString() || err.message, exitCode: err.status };
    }
  },
});

registerNodeType("validation.lint", {
  describe: () => "Run linter and verify results",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm run lint", description: "Lint command" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", default: 120000 },
    },
  },
  async execute(node, ctx) {
    const command = ctx.resolve(node.config?.command || "npm run lint");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    try {
      const output = execSync(command, { cwd, timeout: node.config?.timeoutMs || 120000, encoding: "utf8", stdio: "pipe" });
      return { passed: true, output: output?.trim() };
    } catch (err) {
      return { passed: false, output: err.stderr?.toString() || err.message };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  TRANSFORM — Data manipulation
// ═══════════════════════════════════════════════════════════════════════════
