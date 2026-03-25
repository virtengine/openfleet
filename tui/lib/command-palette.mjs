import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { rankFuzzyMatches } from "./fuzzy-score.mjs";
import { SCREEN_ORDER } from "./navigation.mjs";

const HISTORY_LIMIT = 10;
const RESULT_LIMIT = 8;
const DEFAULT_HISTORY_PATH = path.join(process.cwd(), ".bosun", ".cache", "tui-history.json");
const SESSION_ACTIONS = [
  { key: "kill", label: "Kill", icon: "■", shortcut: "K" },
  { key: "pause", label: "Pause", icon: "‖", shortcut: "P" },
  { key: "resume", label: "Resume", icon: "▶", shortcut: "R" },
  { key: "steer", label: "Steer", icon: "→", shortcut: null },
];
const TASK_ACTIONS = [
  { key: "create", label: "Create task", icon: "+", shortcut: "N" },
  { key: "update", label: "Update", icon: "✎", shortcut: "E" },
  { key: "delete", label: "Delete", icon: "×", shortcut: "X" },
];
const CONFIG_ACTIONS = [
  { key: "config:refresh:1", label: "Set refresh to 1s", icon: "⚙", context: "Config" },
  { key: "config:refresh:2", label: "Set refresh to 2s", icon: "⚙", context: "Config" },
  { key: "config:refresh:5", label: "Set refresh to 5s", icon: "⚙", context: "Config" },
  { key: "config:connectOnly:on", label: "Enable connect-only mode", icon: "⚙", context: "Config" },
  { key: "config:connectOnly:off", label: "Disable connect-only mode", icon: "⚙", context: "Config" },
];

function normalizeRecentIds(recentActionIds = []) {
  return Array.from(new Set((Array.isArray(recentActionIds) ? recentActionIds : []).filter(Boolean))).slice(0, HISTORY_LIMIT);
}

function buildSearchText(action) {
  return [action.label, action.context, action.shortcut, action.keywords].flat().filter(Boolean).join(" ");
}

function actionWithSearch(action) {
  return {
    ...action,
    searchText: buildSearchText(action),
  };
}

function getLabelSortValue(action) {
  return String(action?.label || "").toLocaleLowerCase();
}

export function buildCommandPaletteActions({ sessions = [], tasks = [], workflows = [], currentScreen = "status", recentActionIds = [] } = {}) {
  const recent = normalizeRecentIds(recentActionIds);
  const actions = [];

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = String(session?.id || "").trim();
    if (!sessionId) continue;
    for (const action of SESSION_ACTIONS) {
      actions.push(actionWithSearch({
        id: `session:${action.key}:${sessionId}`,
        type: "session",
        command: action.key,
        icon: action.icon,
        label: `${action.label} ${sessionId}`,
        shortcut: action.shortcut,
        context: `Session ${sessionId}`,
        payload: { sessionId },
        keywords: [session.title, session.status, sessionId.replaceAll("-", "")],
      }));
    }
  }

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const taskId = String(task?.id || "").trim();
    if (!taskId) continue;
    for (const action of TASK_ACTIONS) {
      actions.push(actionWithSearch({
        id: `task:${action.key}:${taskId}`,
        type: "task",
        command: action.key,
        icon: action.icon,
        label: action.key === "create" ? `${action.label}` : `${action.label} ${task.title || taskId}`,
        shortcut: action.shortcut,
        context: action.key === "create" ? "Tasks" : `Task ${taskId}`,
        payload: { taskId, task },
        keywords: [task.title, task.status, taskId],
      }));
    }
  }

  actions.push(actionWithSearch({
    id: "task:create:new",
    type: "task",
    command: "create",
    icon: "+",
    label: "Create task",
    shortcut: "N",
    context: "Tasks",
    payload: {},
    keywords: ["new task", "add task"],
  }));

  for (const workflow of Array.isArray(workflows) ? workflows : []) {
    const workflowId = String(workflow?.id || workflow?.name || "").trim();
    if (!workflowId) continue;
    actions.push(actionWithSearch({
      id: `workflow:trigger:${workflowId}`,
      type: "workflow",
      command: "trigger",
      icon: "⚡",
      label: `Trigger ${workflow.name || workflowId}`,
      shortcut: null,
      context: `Workflow ${workflowId}`,
      payload: { workflowId },
      keywords: [workflow.description, workflow.name, workflowId],
    }));
  }

  for (const screen of SCREEN_ORDER) {
    actions.push(actionWithSearch({
      id: `nav:${screen}`,
      type: "navigation",
      command: "switch",
      icon: "↔",
      label: `Switch to ${screen}`,
      shortcut: String(SCREEN_ORDER.indexOf(screen) + 1),
      context: "Navigation",
      payload: { screen },
      keywords: [screen, currentScreen],
    }));
  }

  for (const configAction of CONFIG_ACTIONS) {
    actions.push(actionWithSearch({
      id: configAction.key,
      type: "config",
      command: "set",
      icon: configAction.icon,
      label: configAction.label,
      shortcut: null,
      context: configAction.context,
      payload: {},
      keywords: ["quick set", "settings", "config"],
    }));
  }

  return actions.map((action) => ({ ...action, recentRank: recent.indexOf(action.id) }));
}

export function rankCommandPaletteActions(query = "", actions = []) {
  const normalizedQuery = String(query || "").trim();
  const list = Array.isArray(actions) ? actions : [];

  if (!normalizedQuery) {
    const recent = list
      .filter((action) => action.recentRank >= 0)
      .sort((left, right) => left.recentRank - right.recentRank);
    const remaining = list
      .filter((action) => action.recentRank < 0)
      .sort((left, right) => getLabelSortValue(left).localeCompare(getLabelSortValue(right)));
    return [...recent, ...remaining].slice(0, RESULT_LIMIT);
  }

  return rankFuzzyMatches(normalizedQuery, list, (action) => action.searchText)
    .map((entry) => entry.item)
    .slice(0, RESULT_LIMIT);
}

export async function loadCommandPaletteHistory({ readFile: read = readFile, historyPath = DEFAULT_HISTORY_PATH } = {}) {
  try {
    const raw = await read(historyPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeRecentIds(parsed?.recent);
  } catch {
    return [];
  }
}

export async function saveCommandPaletteHistory({
  mkdir: ensureDir = mkdir,
  writeFile: write = writeFile,
  historyPath = DEFAULT_HISTORY_PATH,
  actionId,
  recentActionIds = [],
} = {}) {
  const nextRecent = normalizeRecentIds([actionId, ...(Array.isArray(recentActionIds) ? recentActionIds : [])]);
  await ensureDir(path.dirname(historyPath), { recursive: true });
  await write(historyPath, JSON.stringify({ recent: nextRecent }, null, 2), "utf8");
  return nextRecent;
}

export function createCommandPaletteHistoryAdapter(options = {}) {
  return {
    load: () => loadCommandPaletteHistory(options),
    save: ({ actionId, recentActionIds }) => saveCommandPaletteHistory({ ...options, actionId, recentActionIds }),
  };
}
