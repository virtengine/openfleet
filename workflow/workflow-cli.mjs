/**
 * @module workflow-cli
 * @description Helpers for listing and running declarative pipeline workflows.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.mjs";
import {
  listWorkflowDefinitions,
  runConfiguredWorkflow,
} from "./pipeline.mjs";

function getOptionValue(args, flag) {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return String(args[index + 1]).trim();
  }
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1).trim();
  }
  return "";
}

export function parseWorkflowInput(rawValue, cwd = process.cwd()) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return {};

  const maybePath = resolve(cwd, trimmed);
  if (existsSync(maybePath)) {
    const content = readFileSync(maybePath, "utf8");
    try {
      return JSON.parse(content);
    } catch {
      return { title: "Workflow Input", prompt: content, description: content };
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return { title: "Workflow Input", prompt: trimmed, description: trimmed };
  }
}

export function listWorkflowSummaries(config = loadConfig()) {
  return listWorkflowDefinitions(config.workflows || {}).map((entry) => {
    const def = entry.definition;
    const rawStages = def.stages || def.agents || [];
    return {
      name: entry.name,
      source: entry.source,
      type: String(def.type || "sequential"),
      description: String(def.description || "").trim(),
      stageCount: Array.isArray(rawStages) ? rawStages.length : 0,
    };
  });
}

export async function loadWorkflowServices() {
  const agentPool = await import("../agent/agent-pool.mjs");
  return {
    agentPool: {
      launchEphemeralThread: agentPool.launchEphemeralThread,
      launchOrResumeThread: agentPool.launchOrResumeThread,
      execWithRetry: agentPool.execWithRetry,
    },
  };
}

export async function executeWorkflowCommand(args, options = {}) {
  const subcommand = String(args?.[1] || "list").trim().toLowerCase();
  const stdout = options.stdout || ((line) => console.log(line));
  const config = options.config || loadConfig();

  if (subcommand === "list") {
    const summaries = listWorkflowSummaries(config);
    if (summaries.length === 0) {
      stdout("No declarative workflows found.");
      return { ok: true, command: "list", workflows: [] };
    }
    for (const workflow of summaries) {
      stdout(
        `${workflow.name} [${workflow.type}] (${workflow.source})${workflow.description ? ` - ${workflow.description}` : ""}`,
      );
    }
    return { ok: true, command: "list", workflows: summaries };
  }

  if (subcommand === "run") {
    const workflowName = String(args?.[2] || "").trim();
    if (!workflowName) {
      throw new Error("Usage: bosun workflow run <name> [--input <json|file|text>]");
    }
    const input = parseWorkflowInput(getOptionValue(args, "--input"), options.cwd || process.cwd());
    const services = options.services || (await (options.loadServices || loadWorkflowServices)());
    const result = await runConfiguredWorkflow(workflowName, input, {
      workflows: config.workflows || {},
      services,
      createHub: true,
    });
    stdout(JSON.stringify(result, null, 2));
    return { ok: true, command: "run", workflowName, result };
  }

  throw new Error(`Unknown workflow command: ${subcommand}`);
}

export default {
  executeWorkflowCommand,
  listWorkflowSummaries,
  loadWorkflowServices,
  parseWorkflowInput,
};
