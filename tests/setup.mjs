import { spawnSync } from "node:child_process";
import { afterEach } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import "./runtime-bootstrap.mjs";

const ORIGINAL_CONSOLE = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

function detectBlockedChildSpawn() {
  if (process.platform !== "win32") return "0";
  try {
    const result = spawnSync(process.execPath, ["-e", "console.log('spawn-check')"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const errorCode = result?.error?.code;
    return errorCode === "EPERM" || errorCode === "EACCES" ? "1" : "0";
  } catch (error) {
    return error?.code === "EPERM" || error?.code === "EACCES" ? "1" : "0";
  }
}

if (!process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED) {
  process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED = detectBlockedChildSpawn();
}

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

afterEach(() => {
  resetStateLedgerCache();
});
