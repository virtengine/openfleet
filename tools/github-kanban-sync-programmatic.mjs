import fs from "node:fs";
import { execFileSync } from "node:child_process";

const raw = String(process.env.BOSUN_FETCH_PR_STATE || "");
const data = (() => {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
})();
const merged = Array.isArray(data.merged) ? data.merged : [];
const open = Array.isArray(data.open) ? data.open : [];
const updates = [];
const unresolved = [];
const maxBuffer = 25 * 1024 * 1024;
const cliPath = fs.existsSync("cli.mjs") ? "cli.mjs" : "";
const taskCli = ["task-cli.mjs", "task/task-cli.mjs"].find((candidate) => fs.existsSync(candidate)) || "";
const taskRunner = cliPath ? "cli" : (taskCli ? "task-cli" : "");
if (!taskRunner) {
  console.log(JSON.stringify({ updated: 0, unresolved: [{ reason: "task_command_missing" }], needsAgent: true }));
  process.exit(0);
}

function runTask(args) {
  const commandArgs = taskRunner === "cli"
    ? ["cli.mjs", "task", ...args, "--config-dir", ".bosun", "--repo-root", "."]
    : [taskCli, ...args];
  return execFileSync("node", commandArgs, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer,
  }).trim();
}

function parseJsonObject(commandOutput) {
  const text = String(commandOutput || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    const token = lines[start].trim();
    if (!(token === "[" || token === "{" || token.startsWith("[{") || token.startsWith("{\"") || token.startsWith("[\""))) continue;
    const candidate = lines.slice(start).join("\n").trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const compact = lines.map((line) => line.trim()).filter(Boolean);
  for (let index = compact.length - 1; index >= 0; index -= 1) {
    const line = compact[index];
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

let taskListCache = null;

function normalizeRepo(value) {
  return String(value || "").trim().toLowerCase();
}

function listTasks() {
  if (Array.isArray(taskListCache)) return taskListCache;
  try {
    const taskOutput = runTask(["list", "--json"]);
    const tasks = parseJsonObject(taskOutput);
    taskListCache = Array.isArray(tasks) ? tasks : [];
    return taskListCache;
  } catch {
    taskListCache = [];
    return taskListCache;
  }
}

function resolveTaskId(item) {
  const explicit = String(item?.taskId || "").trim();
  if (explicit) return explicit;
  const branch = String(item?.branch || "").trim();
  if (!branch) return "";
  const repo = normalizeRepo(item?.repo);
  const matches = listTasks().filter((task) => {
    const taskBranch = String(task?.branchName || "").trim();
    if (taskBranch !== branch) return false;
    const taskRepo = normalizeRepo(task?.repository || "");
    if (!repo || !taskRepo) return true;
    return taskRepo === repo;
  });
  if (matches.length === 1) return String(matches[0]?.id || "").trim();
  const exactRepo = matches.find((task) => normalizeRepo(task?.repository || "") === repo);
  return exactRepo ? String(exactRepo?.id || "").trim() : "";
}

function getTaskSnapshot(id) {
  try {
    const taskOutput = runTask(["get", id, "--json"]);
    const task = parseJsonObject(taskOutput);
    return {
      status: task?.status || null,
      reviewStatus: task?.reviewStatus || null,
    };
  } catch {
    return {
      status: null,
      reviewStatus: null,
    };
  }
}

for (const item of merged) {
  const id = resolveTaskId(item);
  if (!id) {
    unresolved.push({
      taskId: null,
      repo: String(item?.repo || ""),
      branch: String(item?.branch || ""),
      status: "done",
      reason: "task_lookup_failed",
    });
    continue;
  }
  try {
    runTask(["update", id, "--status", "done"]);
    updates.push({ taskId: id, status: "done" });
  } catch (error) {
    unresolved.push({
      taskId: id,
      status: "done",
      error: String(error?.message || error),
    });
  }
}

for (const item of open) {
  const id = resolveTaskId(item);
  if (!id) {
    unresolved.push({
      taskId: null,
      repo: String(item?.repo || ""),
      branch: String(item?.branch || ""),
      status: "inreview",
      reason: "task_lookup_failed",
    });
    continue;
  }
  try {
    const snapshot = getTaskSnapshot(id);
    const current = String(snapshot?.status || "").trim().toLowerCase();
    const review = String(snapshot?.reviewStatus || "").toLowerCase();
    if (current === "inreview" || current === "done") {
      updates.push({ taskId: id, status: current, skipped: true });
      continue;
    }
    runTask(["update", id, "--status", "inreview"]);
    updates.push({
      taskId: id,
      status: "inreview",
      fromStatus: current || null,
      reviewStatus: review || null,
    });
  } catch (error) {
    unresolved.push({
      taskId: id,
      status: "inreview",
      error: String(error?.message || error),
    });
  }
}

const actionableUnresolved = unresolved.filter((item) => String(item?.taskId || "").trim());
console.log(JSON.stringify({
  updated: updates.length,
  updates,
  unresolved,
  needsAgent: actionableUnresolved.length > 0,
}));
