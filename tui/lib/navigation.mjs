const SCREEN_ORDER = ["status", "tasks", "agents", "telemetry", "logs"];
const SCREEN_BY_INPUT = new Map([
  ["1", "status"],
  ["2", "tasks"],
  ["3", "agents"],
  ["4", "telemetry"],
  ["5", "logs"],
]);

export function getNextScreenForInput(currentScreen = "status", input = "") {
  const next = SCREEN_BY_INPUT.get(String(input || "").trim());
  if (next) return next;
  if (SCREEN_ORDER.includes(currentScreen)) return currentScreen;
  return "status";
}

export { SCREEN_ORDER };
