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
