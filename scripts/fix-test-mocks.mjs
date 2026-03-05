#!/usr/bin/env node
/**
 * fix-test-mocks.mjs — Update vi.mock() paths in test files after module migration.
 *
 * vi.mock() paths must match the resolved module path that the production code uses.
 * After moving modules into sub-folders, vi.mock("../module.mjs") needs to become
 * vi.mock("../subfolder/module.mjs").
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Same mapping as migrate-modules.mjs
const MOVES = {
  "agent-custom-tools.mjs": "agent/", "agent-endpoint.mjs": "agent/",
  "agent-event-bus.mjs": "agent/", "agent-hook-bridge.mjs": "agent/",
  "agent-hooks.mjs": "agent/", "agent-pool.mjs": "agent/",
  "agent-prompts.mjs": "agent/", "agent-sdk.mjs": "agent/",
  "agent-supervisor.mjs": "agent/", "agent-tool-config.mjs": "agent/",
  "agent-work-analyzer.mjs": "agent/", "agent-work-report.mjs": "agent/",
  "analyze-agent-work-helpers.mjs": "agent/", "analyze-agent-work.mjs": "agent/",
  "primary-agent.mjs": "agent/", "review-agent.mjs": "agent/",
  "fleet-coordinator.mjs": "agent/", "hook-profiles.mjs": "agent/",
  "bosun-skills.mjs": "agent/", "autofix.mjs": "agent/",
  "voice-action-dispatcher.mjs": "voice/", "voice-agents-sdk.mjs": "voice/",
  "voice-auth-manager.mjs": "voice/", "voice-relay.mjs": "voice/",
  "voice-tools.mjs": "voice/", "vision-session-state.mjs": "voice/",
  "task-archiver.mjs": "task/", "task-assessment.mjs": "task/",
  "task-attachments.mjs": "task/", "task-claims.mjs": "task/",
  "task-cli.mjs": "task/", "task-complexity.mjs": "task/",
  "task-context.mjs": "task/", "task-debt-ledger.mjs": "task/",
  "task-executor.mjs": "task/", "task-store.mjs": "task/",
  "git-commit-helpers.mjs": "git/", "git-editor-fix.mjs": "git/",
  "git-safety.mjs": "git/", "conflict-resolver.mjs": "git/",
  "sdk-conflict-resolver.mjs": "git/", "diff-stats.mjs": "git/",
  "claude-shell.mjs": "shell/", "codex-shell.mjs": "shell/",
  "copilot-shell.mjs": "shell/", "gemini-shell.mjs": "shell/",
  "opencode-shell.mjs": "shell/", "opencode-providers.mjs": "shell/",
  "codex-config.mjs": "shell/", "codex-model-profiles.mjs": "shell/",
  "pwsh-runtime.mjs": "shell/",
  "workflow-engine.mjs": "workflow/", "workflow-migration.mjs": "workflow/",
  "workflow-nodes.mjs": "workflow/", "workflow-templates.mjs": "workflow/",
  "mcp-workflow-adapter.mjs": "workflow/", "mcp-registry.mjs": "workflow/",
  "manual-flows.mjs": "workflow/", "meeting-workflow-service.mjs": "workflow/",
  "config.mjs": "config/", "config-doctor.mjs": "config/",
  "context-shredding-config.mjs": "config/", "repo-config.mjs": "config/",
  "repo-root.mjs": "config/",
  "telegram-bot.mjs": "telegram/", "telegram-poll-owner.mjs": "telegram/",
  "telegram-sentinel.mjs": "telegram/", "get-telegram-chat-id.mjs": "telegram/",
  "whatsapp-channel.mjs": "telegram/",
  "github-app-auth.mjs": "github/", "github-auth-manager.mjs": "github/",
  "github-oauth-portal.mjs": "github/", "marketplace-webhook.mjs": "github/",
  "issue-trust-guard.mjs": "github/",
  "workspace-manager.mjs": "workspace/", "workspace-monitor.mjs": "workspace/",
  "workspace-registry.mjs": "workspace/", "worktree-manager.mjs": "workspace/",
  "shared-workspace-cli.mjs": "workspace/", "shared-workspace-registry.mjs": "workspace/",
  "shared-state-manager.mjs": "workspace/", "shared-knowledge.mjs": "workspace/",
  "context-cache.mjs": "workspace/", "context-indexer.mjs": "workspace/",
  "ve-kanban.mjs": "kanban/", "kanban-adapter.mjs": "kanban/",
  "vibe-kanban-wrapper.mjs": "kanban/", "vk-error-resolver.mjs": "kanban/",
  "vk-log-stream.mjs": "kanban/", "ve-orchestrator.mjs": "kanban/",
  "monitor.mjs": "infra/", "restart-controller.mjs": "infra/",
  "startup-service.mjs": "infra/", "update-check.mjs": "infra/",
  "maintenance.mjs": "infra/", "preflight.mjs": "infra/",
  "presence.mjs": "infra/", "session-tracker.mjs": "infra/",
  "stream-resilience.mjs": "infra/", "anomaly-detector.mjs": "infra/",
  "error-detector.mjs": "infra/", "container-runner.mjs": "infra/",
  "daemon-restart-policy.mjs": "infra/", "fetch-runtime.mjs": "infra/",
  "sync-engine.mjs": "infra/", "desktop-api-key.mjs": "infra/",
  "desktop-shortcut.mjs": "infra/", "library-manager.mjs": "infra/",
  "ui-server.mjs": "server/", "setup-web-server.mjs": "server/",
  "playwright-ui-inspect.mjs": "server/", "playwright-ui-server.mjs": "server/",
};

// vi.mock("../filename.mjs", ...) → vi.mock("../folder/filename.mjs", ...)
// Pattern matches vi.mock("../filename.mjs" ...
const VI_MOCK_RE = /(vi\.mock\s*\(\s*["'])(\.\.\/)([^"']+)(["'])/g;

const testsDir = resolve(ROOT, "tests");
const testFiles = readdirSync(testsDir).filter(f => f.endsWith(".mjs"));
let filesChanged = 0;
let mocksRewritten = 0;

for (const file of testFiles) {
  const filePath = resolve(testsDir, file);
  let content = readFileSync(filePath, "utf8");
  let changed = false;

  content = content.replace(VI_MOCK_RE, (match, prefix, dotdotSlash, filename, suffix) => {
    // filename is like "config.mjs" or "voice-tools.mjs"
    const folder = MOVES[filename];
    if (folder) {
      changed = true;
      mocksRewritten++;
      return `${prefix}${dotdotSlash}${folder}${filename}${suffix}`;
    }
    return match;
  });

  if (changed) {
    filesChanged++;
    writeFileSync(filePath, content, "utf8");
    console.log(`  ✓ ${file} (${mocksRewritten} mocks rewritten)`);
  }
}

console.log(`\nFiles changed: ${filesChanged}, mocks rewritten: ${mocksRewritten}`);
