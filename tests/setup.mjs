import "./warning-filter.mjs";
import { spawnSync } from "node:child_process";
import { afterEach } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import "./runtime-bootstrap.mjs";
import { installTestLogFilter } from "./test-log-filter.mjs";

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

installTestLogFilter();

afterEach(() => {
  resetStateLedgerCache();
});
