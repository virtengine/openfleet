import { _resetSingleton } from "../session-tracker.mjs";

// ── Isolate session tracker from disk during tests ──────────────────────────
// The singleton defaults to persistDir = `logs/sessions/`, which means any
// test that transitively calls getSessionTracker() (e.g. via the real
// ui-server) would write session JSON files into the working tree and pollute
// real sessions after the run.  Pre-seed the singleton with persistDir: null
// so all session tracking stays in-memory only.
_resetSingleton({ persistDir: null });

const ORIGINAL_CONSOLE = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

const SUPPRESSED_PREFIXES = [
  /^\[archiver\]/i,
  /^\[kanban\]/i,
  /^\[sharedstatemanager\]/i,
  /^\[config\]/i,
  /^\[agent-prompts\]/i,
];

function shouldSuppress(args) {
  if (!args || args.length === 0) return false;
  const message = args.map((arg) => String(arg)).join(" ");
  return SUPPRESSED_PREFIXES.some((pattern) => pattern.test(message));
}

console.error = (...args) => {
  if (shouldSuppress(args)) return;
  ORIGINAL_CONSOLE.error(...args);
};

console.warn = (...args) => {
  if (shouldSuppress(args)) return;
  ORIGINAL_CONSOLE.warn(...args);
};
