#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { executeBlockingHooks, executeHooks, loadHooks, registerBuiltinHooks } from "./agent-hooks.mjs";

const TAG = "[agent-hook-bridge]";

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      i++;
    } else {
      result[key] = "1";
    }
  }
  return result;
}

function readStdInJson() {
  try {
    const raw = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
    if (raw && raw.trim()) {
      return JSON.parse(raw);
    }
  } catch {
    /* ignore parse errors */
  }

  return {};
}

function normalizeAgent(agent) {
  const raw = String(agent || "")
    .trim()
    .toLowerCase();
  if (["codex", "copilot", "claude"].includes(raw)) return raw;
  return "codex";
}

function normalizeSourceEvent(event) {
  return String(event || "").trim();
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const nested of Object.values(value)) {
    collectStrings(nested, out);
  }
  return out;
}

function extractCommand(payload) {
  const candidates = [
    payload?.command,
    payload?.cmd,
    payload?.tool_input?.command,
    payload?.toolInput?.command,
    payload?.input?.command,
    payload?.eventData?.input?.command,
    payload?.event_data?.input?.command,
    payload?.toolArguments?.command,
    payload?.tool_arguments?.command,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const strings = collectStrings(payload);
  const command = strings.find((text) => /\b(git|gh)\b/i.test(text));
  return command || "";
}

function extractToolName(payload) {
  const candidates = [
    payload?.toolName,
    payload?.tool_name,
    payload?.tool,
    payload?.eventData?.toolName,
    payload?.event_data?.tool_name,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function classifyCommand(command) {
  const normalized = String(command || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return null;
  if (/\bgit\s+push\b/.test(normalized)) return "push";
  if (/\bgit\s+commit\b/.test(normalized)) return "commit";
  if (/\bgh\s+pr\s+create\b/.test(normalized)) return "pr";
  return null;
}

function mapEvents(sourceEvent, payload) {
  const raw = normalizeSourceEvent(sourceEvent).toLowerCase();
  const command = extractCommand(payload);
  const action = classifyCommand(command);

  if (raw === "sessionstart" || raw === "userpromptsubmit" || raw === "promptsubmit") {
    return [{ event: "SessionStart", blocking: false, command }];
  }
  if (raw === "sessionend" || raw === "stop") {
    return [{ event: "SessionStop", blocking: false, command }];
  }
  if (raw === "pretooluse") {
    if (action === "push") {
      return [{ event: "PrePush", blocking: true, command }];
    }
    if (action === "commit") {
      return [{ event: "PreCommit", blocking: true, command }];
    }
    if (action === "pr") {
      return [{ event: "PrePR", blocking: true, command }];
    }
    return [{ event: "PreToolUse", blocking: false, command }];
  }
  if (raw === "posttooluse") {
    if (action === "push") {
      return [{ event: "PostPush", blocking: false, command }];
    }
    if (action === "commit") {
      return [{ event: "PostCommit", blocking: false, command }];
    }
    if (action === "pr") {
      return [{ event: "PostPR", blocking: false, command }];
    }
    return [{ event: "PostToolUse", blocking: false, command }];
  }
  if (raw === "subagentstop") {
    return [{ event: "SubagentStop", blocking: false, command }];
  }

  return [];
}

async function run() {
  // ── VE_MANAGED guard ──────────────────────────────────────────────────────
  // Only execute hooks for sessions managed by openfleet.
  // openfleet sets VE_MANAGED=1 in all spawned agent environments.
  // If this env var is missing, we're running inside a standalone agent session
  // that just happens to have the hook files in its config — exit silently.
  if (!process.env.VE_MANAGED && !process.env.OPENFLEET_HOOKS_FORCE) {
    process.exit(0);
  }

  const args = parseArgs(process.argv);
  const agent = normalizeAgent(args.agent || process.env.VE_SDK || "codex");
  const sourceEvent = args.event || "";
  const payload = readStdInJson();
  const toolName = extractToolName(payload);
  const mapped = mapEvents(sourceEvent, payload);

  if (mapped.length === 0) {
    process.exit(0);
  }

  loadHooks();
  registerBuiltinHooks();

  for (const item of mapped) {
    const context = {
      sdk: agent,
      taskId: process.env.VE_TASK_ID || "",
      taskTitle: process.env.VE_TASK_TITLE || "",
      taskDescription:
        process.env.VE_TASK_DESCRIPTION ||
        process.env.VE_DESCRIPTION ||
        process.env.VK_DESCRIPTION ||
        "",
      branch: process.env.VE_BRANCH_NAME || "",
      worktreePath: process.cwd(),
      extra: {
        source_event: sourceEvent,
        tool_name: toolName,
        command: item.command || "",
      },
    };

    if (item.blocking) {
      const result = await executeBlockingHooks(item.event, context);
      if (!result.passed) {
        const errors = result.failures
          .map((failure) => {
            const detail = failure.stderr || failure.error || "hook failed";
            return `${failure.id}: ${detail}`;
          })
          .join(" | ");
        console.error(`${TAG} blocking hook failure for ${item.event}: ${errors}`);
        process.exit(2);
      }
      continue;
    }

    await executeHooks(item.event, context);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error(`${TAG} ${err.message}`);
  process.exit(1);
});
