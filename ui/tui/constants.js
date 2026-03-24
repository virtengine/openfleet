import figures from "figures";

export const ANSI_COLORS = Object.freeze({
  connected: "green",
  reconnecting: "yellow",
  disconnected: "red",
  muted: "gray",
  accent: "cyan",
  warning: "yellow",
  danger: "red",
});

export const MIN_TERMINAL_SIZE = Object.freeze({ columns: 120, rows: 30 });

export const TAB_ORDER = Object.freeze([
  { id: "agents", label: "Agents", shortcut: "a" },
  { id: "tasks", label: "Tasks", shortcut: "t" },
  { id: "logs", label: "Logs", shortcut: "l" },
  { id: "workflows", label: "Workflows", shortcut: "w" },
  { id: "telemetry", label: "Telemetry", shortcut: "x" },
  { id: "settings", label: "Settings", shortcut: "s" },
  { id: "help", label: "Help", shortcut: "?" },
]);

export const KEY_BINDINGS = Object.freeze({
  a: "agents",
  t: "tasks",
  l: "logs",
  w: "workflows",
  x: "telemetry",
  s: "settings",
  "?": "help",
  tab: "next",
  shiftTab: "previous",
  q: "quit",
});

export const COLUMN_WIDTHS = Object.freeze({
  id: 10,
  status: 12,
  priority: 10,
  title: 40,
  turns: 7,
  updated: 18,
  workflow: 28,
});

export const GLYPHS = Object.freeze({
  connected: figures.circleFilled || "●",
  reconnectingOn: figures.circleFilled || "●",
  reconnectingOff: figures.circleDotted || "◌",
  disconnected: figures.cross || "×",
  warning: figures.warning || "⚠",
  pointer: figures.pointer || ">",
});
