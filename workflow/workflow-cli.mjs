import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.mjs";
import {
  listConfiguredWorkflows,
  loadWorkflowInputFromFile,
  runConfiguredWorkflow,
} from "./declarative-workflows.mjs";
import { inspectCustomWorkflowNodePlugins } from "./workflow-nodes.mjs";

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function getArgValue(args, flag) {
  const direct = args.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1).trim();
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return String(args[index + 1] || "").trim();
  return "";
}

export function parseWorkflowInput(rawValue, cwd = process.cwd()) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return "";
  const fullPath = resolve(cwd, trimmed);
  if (existsSync(fullPath)) {
    const raw = readFileSync(fullPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseInput(args, cwd = process.cwd()) {
  const inputFile = getArgValue(args, "--file");
  if (inputFile) return loadWorkflowInputFromFile(inputFile);
  const inlineJson = getArgValue(args, "--input-json");
  if (inlineJson) return JSON.parse(inlineJson);
  const inputText = getArgValue(args, "--input");
  if (inputText) return parseWorkflowInput(inputText, cwd);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  return positional.length > 2 ? positional.slice(2).join(" ") : "";
}

function formatCustomNodeHealthReport(report) {
  const lines = [
    "Custom node health",
    `repo=${report.repoRoot}`,
    `discovered=${report.summary.discovered} loaded=${report.summary.loaded} skipped=${report.summary.skipped} duplicateNodeIds=${report.summary.duplicateNodeIds} smokePassed=${report.summary.smokePassed} smokeFailed=${report.summary.smokeFailed}`,
  ];
  for (const plugin of report.plugins) {
    const manifestText = plugin.manifest?.id
      ? ` manifest=${plugin.manifest.id}@${plugin.manifest.version}`
      : "";
    lines.push(`- ${plugin.fileName}\t${plugin.status}${manifestText}`);
    for (const diagnostic of plugin.diagnostics || []) {
      lines.push(`  ! ${diagnostic.code}: ${diagnostic.message}`);
    }
    if (plugin.smokeTest) {
      lines.push(`  smoke=${plugin.smokeTest.status} ${plugin.smokeTest.message}`);
    }
  }
  return lines;
}

function showHelp(stdout = console.log) {
  stdout(`
  bosun workflow — Declarative multi-agent workflows

  SUBCOMMANDS
    list                      List configured and built-in workflows
    run <name> [input]        Run a workflow with fresh-context agents
    nodes                     Inspect custom workflow node plugin health

  OPTIONS
    --json                    Emit JSON output
    --dry-run                 Render prompts without executing agents
    --input <text>            Inline workflow input
    --input-json <json>       Structured JSON input
    --file <path>             Load workflow input from a file
    --smoke                   Run plugin smoke tests during health inspection
`);
}

export function listWorkflowSummaries(config = loadConfig(process.argv)) {
  return listConfiguredWorkflows(config);
}

export async function executeWorkflowCommand(args, options = {}) {
  const normalizedArgs = Array.isArray(args) && args[0] === "workflow" ? args.slice(1) : args;
  const subcommand = normalizedArgs?.[0] || "list";
  const stdout = options.stdout || ((line) => console.log(line));
  if (hasFlag(normalizedArgs, "--help", "-h") || subcommand === "help") {
    showHelp(stdout);
    return { ok: true, command: "help" };
  }

  const asJson = hasFlag(normalizedArgs, "--json") || options.json === true;
  if (subcommand === "nodes") {
    const inspectorOptions = {
      forceReload: hasFlag(normalizedArgs, "--reload", "--force-reload"),
      runSmokeTests: hasFlag(normalizedArgs, "--smoke", "--run-smoke-tests"),
      logWarnings: false,
    };
    if (options.repoRoot) {
      inspectorOptions.repoRoot = options.repoRoot;
    } else if (options.cwd) {
      inspectorOptions.repoRoot = options.cwd;
    }
    const report = await inspectCustomWorkflowNodePlugins(inspectorOptions);
    if (asJson) {
      stdout(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatCustomNodeHealthReport(report)) stdout(line);
    }
    return { ok: true, command: "nodes", report };
  }

  const config = options.config || loadConfig(process.argv);
  if (subcommand === "list") {
    const workflows = listConfiguredWorkflows(config);
    if (asJson) {
      stdout(JSON.stringify(workflows, null, 2));
    } else {
      for (const workflow of workflows) {
        stdout(`${workflow.id}\t${workflow.type}\t${workflow.description}`);
      }
    }
    return { ok: true, command: "list", workflows };
  }

  if (subcommand === "run") {
    const name = normalizedArgs[1];
    if (!name) throw new Error("Workflow name is required. Usage: bosun workflow run <name>");
    const input = parseInput(normalizedArgs, options.cwd || process.cwd());
    const result = await runConfiguredWorkflow(name, input, {
      config,
      dryRun: hasFlag(normalizedArgs, "--dry-run"),
      services: options.services,
      runOptions: options.runOptions,
    });
    if (asJson || options.forceJsonOutput === true) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      stdout(`workflow=${result.workflow.id} status=${result.status} outputs=${result.outputs.length} errors=${result.errors.length}`);
      for (const output of result.outputs) {
        const summary = String(output.summary || output.output || "").slice(0, 160);
        stdout(`- ${output.agentId}: ${summary}`);
      }
      if (result.consensus?.text) {
        stdout(`consensus=${result.consensus.text}`);
      }
    }
    return { ok: true, command: "run", workflowName: name, result };
  }

  throw new Error(`Unknown workflow subcommand: ${subcommand}`);
}

export async function runWorkflowCli(args, options = {}) {
  return executeWorkflowCommand(["workflow", ...(Array.isArray(args) ? args : [])], options);
}

export default runWorkflowCli;
