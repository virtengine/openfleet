const SCREEN_ORDER = ["status", "tasks", "agents", "logs", "workflows", "telemetry", "settings"];
const SCREEN_BY_INPUT = new Map([
  ["1", "status"],
  ["2", "tasks"],
  ["3", "agents"],
  ["4", "logs"],
  ["5", "workflows"],
  ["6", "telemetry"],
  ["7", "settings"],
]);

export function getNextScreenForInput(currentScreen = "status", input = "") {
  const next = SCREEN_BY_INPUT.get(String(input || "").trim());
  if (next) return next;
  if (SCREEN_ORDER.includes(currentScreen)) return currentScreen;
  return "status";
}

export { SCREEN_ORDER };
