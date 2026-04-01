import "./warning-filter.mjs";
import { afterEach } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import "./runtime-bootstrap.mjs";
import { installTestLogFilter } from "./test-log-filter.mjs";

installTestLogFilter();

afterEach(() => {
  resetStateLedgerCache();
});
