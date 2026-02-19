#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, ".cache");
const EXECUTOR_STATE_PATH = resolve(CACHE_DIR, "ve-kanban-executor-state.json");

const DEFAULT_EXECUTOR_PROFILES = [
  { executor: "CODEX", variant: "DEFAULT" },
  { executor: "COPILOT", variant: "CLAUDE_OPUS_4_6" },
];

function logInfo(msg) {
  console.log(`  ${msg}`);
}

function logWarn(msg) {
  console.warn(`  ⚠ ${msg}`);
}

function logError(msg) {
  console.error(`  ✗ ${msg}`);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function getPayloadData(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return payload;
  if (payload.success === false) {
    throw new Error(payload.message || "VK API returned success=false");
  }
  return payload.data ?? payload.tasks ?? payload.projects ?? payload;
}

function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // best-effort cache write
  }
}

function isTruthy(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseExecutorProfiles(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return DEFAULT_EXECUTOR_PROFILES;
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [executorRaw, variantRaw] = item.split(":").map((part) => (part || "").trim());
      if (!executorRaw) return null;
      return {
        executor: executorRaw.toUpperCase(),
        variant: variantRaw || "DEFAULT",
      };
    })
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_EXECUTOR_PROFILES;
}

function parseRepoSlug(raw) {
  const text = String(raw || "").trim().replace(/^https?:\/\/github\.com\//i, "");
  if (!text) return null;
  const cleaned = text.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const [owner, repo] = cleaned.split("/", 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function normalizeTaskStatus(raw) {
  const key = String(raw || "todo").toLowerCase().trim();
  const map = {
    todo: "todo",
    open: "todo",
    inprogress: "inprogress",
    "in-progress": "inprogress",
    in_progress: "inprogress",
    inreview: "inreview",
    "in-review": "inreview",
    in_review: "inreview",
    done: "done",
    closed: "done",
    cancelled: "cancelled",
    canceled: "cancelled",
  };
  return map[key] || "todo";
}

function parseValueFlag(args, flags, defaultValue = null) {
  for (let i = 0; i < args.length; i += 1) {
    if (flags.includes(args[i]) && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return defaultValue;
}

function hasFlag(args, flags) {
  return args.some((arg) => flags.includes(arg));
}

function truncate(value, max = 72) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function sortByCreatedAsc(items) {
  return [...items].sort((a, b) => {
    const aTs = Date.parse(a?.created_at || a?.createdAt || 0) || 0;
    const bTs = Date.parse(b?.created_at || b?.createdAt || 0) || 0;
    return aTs - bTs;
  });
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class VeKanbanRuntime {
  constructor(options = {}) {
    const env = options.env || process.env;
    const slugInfo =
      parseRepoSlug(env.GITHUB_REPOSITORY) ||
      parseRepoSlug(
        env.GITHUB_REPO_OWNER && env.GITHUB_REPO_NAME
          ? `${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`
          : "",
      );
    this.env = env;
    this.baseUrl =
      options.baseUrl ||
      env.VK_ENDPOINT_URL ||
      env.VK_BASE_URL ||
      "http://127.0.0.1:54089";
    this.projectName =
      options.projectName || env.VK_PROJECT_NAME || slugInfo?.repo || "default-project";
    this.projectId = options.projectId || env.VK_PROJECT_ID || "";
    this.repoId = options.repoId || env.VK_REPO_ID || "";
    this.targetBranch = options.targetBranch || env.VK_TARGET_BRANCH || "origin/main";
    this.ghOwner =
      options.ghOwner ||
      env.GH_OWNER ||
      env.GITHUB_REPO_OWNER ||
      slugInfo?.owner ||
      "unknown";
    this.ghRepo =
      options.ghRepo ||
      env.GH_REPO ||
      env.GITHUB_REPO_NAME ||
      slugInfo?.repo ||
      "unknown";
    this.executorProfiles = parseExecutorProfiles(env.VK_EXECUTOR_PROFILES);
    this.executorStatePath = options.executorStatePath || EXECUTOR_STATE_PATH;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  async api(path, opts = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("global fetch is unavailable in this Node runtime");
    }
    const method = (opts.method || "GET").toUpperCase();
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = { "content-type": "application/json" };
    const fetchOptions = {
      method,
      headers,
    };
    if (opts.body != null && method !== "GET") {
      fetchOptions.body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(url, fetchOptions);
    const rawText = await res.text();
    let payload;
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error(`VK API ${method} ${path} returned non-JSON: ${truncate(rawText, 200)}`);
    }
    if (!res.ok) {
      const detail = payload?.message || payload?.error || rawText || `HTTP ${res.status}`;
      throw new Error(`VK API ${method} ${path} failed: ${detail}`);
    }
    return getPayloadData(payload);
  }

  async ensureConfig() {
    if (!this.projectId) {
      const projectsPayload = await this.api("/api/projects");
      const projects = asArray(projectsPayload);
      const target = projects.find((project) => {
        const names = [project?.name, project?.display_name, project?.title]
          .map((value) => String(value || "").toLowerCase())
          .filter(Boolean);
        return names.includes(String(this.projectName).toLowerCase());
      });
      if (!target) {
        const available = projects
          .map((project) => project?.name || project?.display_name || project?.title || project?.id)
          .filter(Boolean)
          .join(", ");
        throw new Error(
          `No project named \"${this.projectName}\" found at ${this.baseUrl}. Available: ${available || "(none)"}`,
        );
      }
      this.projectId = target.id;
    }

    if (!this.repoId) {
      let reposPayload;
      try {
        reposPayload = await this.api(`/api/repos?project_id=${encodeURIComponent(this.projectId)}`);
      } catch {
        reposPayload = await this.api(`/api/projects/${encodeURIComponent(this.projectId)}/repos`);
      }
      const repos = asArray(reposPayload);
      if (repos.length === 0) {
        throw new Error(`No repos returned for project ${this.projectId}. Set VK_REPO_ID manually.`);
      }
      const preferredRepoName = this.ghRepo.toLowerCase();
      const repo =
        repos.find((candidate) => String(candidate?.name || "").toLowerCase() === preferredRepoName) ||
        repos[0];
      this.repoId = repo.id;
    }

    return { projectId: this.projectId, repoId: this.repoId };
  }

  async listTasks(status = null) {
    await this.ensureConfig();
    const payload = await this.api(`/api/tasks?project_id=${encodeURIComponent(this.projectId)}`);
    const tasks = asArray(payload);
    if (!status) return tasks;
    const targetStatus = normalizeTaskStatus(status);
    return tasks.filter((task) => normalizeTaskStatus(task?.status) === targetStatus);
  }

  async getTask(taskId) {
    return this.api(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async createTask({ title, description, status = "todo" }) {
    await this.ensureConfig();
    return this.api(`/api/tasks`, {
      method: "POST",
      body: {
        title,
        description,
        status: normalizeTaskStatus(status),
        project_id: this.projectId,
      },
    });
  }

  async updateTaskStatus(taskId, status) {
    return this.api(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      body: { status: normalizeTaskStatus(status) },
    });
  }

  async listAttempts() {
    const payload = await this.api(`/api/task-attempts`);
    return asArray(payload);
  }

  async listArchivedAttempts() {
    const attempts = await this.listAttempts();
    return attempts.filter((attempt) => Boolean(attempt?.archived));
  }

  async archiveAttempt(attemptId, archived = true) {
    return this.api(`/api/task-attempts/${encodeURIComponent(attemptId)}`, {
      method: "PUT",
      body: { archived: Boolean(archived) },
    });
  }

  async rebaseAttempt(attemptId, baseBranch = this.targetBranch) {
    await this.ensureConfig();
    return this.api(`/api/task-attempts/${encodeURIComponent(attemptId)}/rebase`, {
      method: "POST",
      body: {
        repo_id: this.repoId,
        old_base_branch: baseBranch,
        new_base_branch: baseBranch,
      },
    });
  }

  isCopilotCloudDisabled() {
    if (isTruthy(this.env.COPILOT_CLOUD_DISABLED)) return true;
    const until = this.env.COPILOT_CLOUD_DISABLED_UNTIL;
    if (!until) return false;
    const ts = Date.parse(until);
    if (!Number.isFinite(ts)) return false;
    return Date.now() < ts;
  }

  getNextExecutorProfile() {
    const profiles = this.executorProfiles.length > 0 ? this.executorProfiles : DEFAULT_EXECUTOR_PROFILES;
    const state = readJsonFile(this.executorStatePath, {
      index: Math.floor(Math.random() * profiles.length),
    });
    let index = Number.isFinite(state?.index) ? state.index : 0;

    for (let i = 0; i < profiles.length; i += 1) {
      const profile = profiles[((index % profiles.length) + profiles.length) % profiles.length];
      index += 1;
      if (this.isCopilotCloudDisabled() && profile.executor === "COPILOT") {
        continue;
      }
      writeJsonFile(this.executorStatePath, { index: index % profiles.length });
      return profile;
    }

    const fallback = profiles[0];
    writeJsonFile(this.executorStatePath, { index: 1 % profiles.length });
    return fallback;
  }

  async submitTaskAttempt(taskId, options = {}) {
    await this.ensureConfig();
    const executorProfile = options.executorOverride || this.getNextExecutorProfile();
    const targetBranch = options.targetBranch || this.targetBranch;
    return this.api(`/api/task-attempts`, {
      method: "POST",
      body: {
        task_id: taskId,
        repos: [
          {
            repo_id: this.repoId,
            target_branch: targetBranch,
          },
        ],
        executor_profile_id: {
          executor: executorProfile.executor,
          variant: executorProfile.variant,
        },
      },
    });
  }

  runGh(args) {
    try {
      const output = execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output: stripAnsi(output).trim(), error: "" };
    } catch (err) {
      const stderr = stripAnsi(err?.stderr?.toString?.() || err?.message || "").trim();
      return { ok: false, output: "", error: stderr };
    }
  }

  findPullRequestForBranch(branch, state = "open") {
    const result = this.runGh([
      "pr",
      "list",
      "--repo",
      `${this.ghOwner}/${this.ghRepo}`,
      "--head",
      branch,
      "--state",
      state,
      "--json",
      "number,state,url,title",
      "--limit",
      "1",
    ]);
    if (!result.ok || !result.output) return null;
    try {
      const rows = JSON.parse(result.output);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    } catch {
      return null;
    }
  }

  mergePullRequest(prNumber, { auto = false } = {}) {
    const args = [
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      `${this.ghOwner}/${this.ghRepo}`,
      "--squash",
      "--delete-branch",
    ];
    if (auto) args.push("--auto");
    return this.runGh(args);
  }
}

export function parseKanbanCommand(argv) {
  const args = [...argv];
  if (args.length === 0) return { command: "help", args: [] };
  return { command: args[0], args: args.slice(1) };
}

function printTaskList(tasks, status) {
  if (!tasks || tasks.length === 0) {
    logInfo(`No tasks found for status=${status}.`);
    return;
  }
  logInfo(`Tasks (${status}):`);
  for (const task of tasks) {
    const id = String(task?.id || "").slice(0, 8);
    const title = truncate(task?.title || "(untitled)", 100);
    logInfo(`- ${id}  ${title}`);
  }
}

function printStatusDashboard(tasks, attempts, showVerbose = false) {
  const todo = tasks.filter((task) => normalizeTaskStatus(task?.status) === "todo");
  const inProgress = tasks.filter((task) => normalizeTaskStatus(task?.status) === "inprogress");
  const activeAttempts = attempts.filter((attempt) => !attempt?.archived);

  logInfo(`Todo: ${todo.length}`);
  logInfo(`In-Progress: ${inProgress.length}`);
  logInfo(`Active Attempts: ${activeAttempts.length}`);

  if (activeAttempts.length > 0) {
    logInfo("Active attempts:");
    for (const attempt of activeAttempts) {
      const id = String(attempt?.id || "").slice(0, 8);
      const branch = attempt?.branch || attempt?.branch_name || "(no branch)";
      const name = truncate(attempt?.name || attempt?.task_title || "(unnamed)", 90);
      logInfo(`- ${id}  ${branch}`);
      logInfo(`  ${name}`);
      if (showVerbose) {
        const lastUpdate = attempt?.updated_at || attempt?.created_at || "unknown";
        logInfo(`  last update: ${lastUpdate}`);
      }
    }
  }
}

export async function runKanbanCli(argv, runtime = new VeKanbanRuntime()) {
  const { command, args } = parseKanbanCommand(argv);

  switch (command) {
    case "create": {
      const title = parseValueFlag(args, ["--title", "-t"], null);
      let description = parseValueFlag(args, ["--description", "--desc", "-d"], null);
      const descFile = parseValueFlag(args, ["--description-file", "--desc-file"], null);
      const status = parseValueFlag(args, ["--status", "-s"], "todo");
      if (!description && descFile) {
        description = readFileSync(resolve(process.cwd(), descFile), "utf8");
      }
      if (!title || !description) {
        throw new Error("Usage: ve-kanban create --title <title> --description <markdown> [--status todo]");
      }
      const created = await runtime.createTask({ title, description, status });
      logInfo(`✓ Task created: ${created?.id || "(id unavailable)"} — ${title}`);
      return 0;
    }

    case "list": {
      const status = parseValueFlag(args, ["--status", "-s"], "todo");
      const tasks = await runtime.listTasks(status);
      printTaskList(tasks, status);
      return 0;
    }

    case "status": {
      const showVerbose = hasFlag(args, ["--verbose", "-v"]);
      const tasks = await runtime.listTasks();
      const attempts = await runtime.listAttempts();
      printStatusDashboard(tasks, attempts, showVerbose);
      return 0;
    }

    case "archived": {
      const attempts = await runtime.listArchivedAttempts();
      if (attempts.length === 0) {
        logInfo("No archived attempts.");
        return 0;
      }
      logInfo("Archived attempts:");
      for (const attempt of attempts) {
        const id = String(attempt?.id || "").slice(0, 8);
        const branch = attempt?.branch || attempt?.branch_name || "(no branch)";
        logInfo(`- ${id}  ${branch}`);
      }
      return 0;
    }

    case "unarchive": {
      const attemptId = args[0];
      if (!attemptId) throw new Error("Usage: ve-kanban unarchive <attempt-id>");
      await runtime.archiveAttempt(attemptId, false);
      logInfo(`✓ Attempt ${attemptId} unarchived`);
      return 0;
    }

    case "submit": {
      const taskId = args[0];
      if (!taskId) throw new Error("Usage: ve-kanban submit <task-id>");
      const attempt = await runtime.submitTaskAttempt(taskId);
      logInfo(`✓ Attempt created: ${attempt?.id || "(id unavailable)"} → branch ${attempt?.branch || "(unknown)"}`);
      return 0;
    }

    case "submit-next": {
      const count = toInt(parseValueFlag(args, ["--count", "-n"], "1"), 1);
      const todo = sortByCreatedAsc(await runtime.listTasks("todo"));
      const selected = todo.slice(0, Math.max(0, count));
      if (selected.length === 0) {
        logInfo("No todo tasks available.");
        return 0;
      }
      for (const task of selected) {
        logInfo(`→ ${task?.title || task?.id}`);
        const attempt = await runtime.submitTaskAttempt(task.id);
        logInfo(`  ✓ ${attempt?.id || "(id unavailable)"} ${attempt?.branch || ""}`);
      }
      return 0;
    }

    case "rebase": {
      const attemptId = args[0];
      if (!attemptId) throw new Error("Usage: ve-kanban rebase <attempt-id>");
      await runtime.rebaseAttempt(attemptId);
      logInfo(`✓ Rebase requested for attempt ${attemptId}`);
      return 0;
    }

    case "merge": {
      const branch = parseValueFlag(args, ["--branch", "-b"], args.find((value) => !value.startsWith("-")) || null);
      const auto = hasFlag(args, ["--auto"]);
      if (!branch) throw new Error("Usage: ve-kanban merge <branch> [--auto]");
      const pr = runtime.findPullRequestForBranch(branch, "open") || runtime.findPullRequestForBranch(branch, "all");
      if (!pr) throw new Error(`No PR found for branch ${branch}`);
      const merged = runtime.mergePullRequest(pr.number, { auto });
      if (!merged.ok) throw new Error(merged.error || `Failed to merge PR #${pr.number}`);
      logInfo(`✓ PR #${pr.number} merge requested${auto ? " (auto-merge)" : ""}`);
      return 0;
    }

    case "complete": {
      const taskId = args[0];
      if (!taskId) throw new Error("Usage: ve-kanban complete <task-id>");
      await runtime.updateTaskStatus(taskId, "done");
      logInfo(`✓ Task ${taskId} marked as done`);
      return 0;
    }

    case "orchestrate": {
      const parallel = toInt(parseValueFlag(args, ["--parallel", "-p"], "2"), 2);
      const interval = toInt(parseValueFlag(args, ["--interval", "-i"], "60"), 60);
      const orchestratorPath = resolve(__dirname, "ve-orchestrator.mjs");
      logInfo(`Delegating to ve-orchestrator.mjs with parallel=${parallel}, interval=${interval}s`);
      const child = spawnSync(process.execPath, [orchestratorPath, "-MaxParallel", String(parallel), "-PollIntervalSec", String(interval)], {
        stdio: "inherit",
        env: { ...process.env },
      });
      return child.status ?? 1;
    }

    case "help":
    case "--help":
    case "-h":
      printUsage();
      return 0;

    default:
      printUsage();
      throw new Error(`Unknown command: ${command}`);
  }
}

export function printUsage() {
  console.log(`
  OpenFleet Kanban CLI (ve-kanban)
  =================================

  Commands:
    create --title <title> --description <md> [--status todo]
    list [--status <status>]
    status [--verbose]
    archived
    unarchive <attempt-id>
    submit <task-id>
    submit-next [--count N]
    rebase <attempt-id>
    merge <branch> [--auto]
    complete <task-id>
    orchestrate [--parallel N] [--interval sec]
    help

  Environment:
    VK_BASE_URL / VK_ENDPOINT_URL
    VK_PROJECT_NAME / VK_PROJECT_ID / VK_REPO_ID
    GH_OWNER / GH_REPO
    VK_TARGET_BRANCH (default: origin/main)
`);
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runKanbanCli(process.argv.slice(2))
    .then((code) => {
      if (Number.isFinite(code) && code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      logError(err?.message || String(err));
      process.exit(1);
    });
}
