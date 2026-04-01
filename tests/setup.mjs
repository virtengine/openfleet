import "./warning-filter.mjs";
import { afterEach } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import "./runtime-bootstrap.mjs";
import { installTestLogFilter } from "./test-log-filter.mjs";

installTestLogFilter();

afterEach(() => {
  const debugCleanup = process.env.BOSUN_TEST_HARNESS_DEBUG_CLEANUP === "1";
  const startedAt = debugCleanup ? Date.now() : 0;
  resetStateLedgerCache();
  if (debugCleanup) {
    console.error(`[tests/setup] resetStateLedgerCache +${Date.now() - startedAt}ms`);
  }
});
