#!/usr/bin/env node

import { runTaskCli } from "./task-cli.mjs";

runTaskCli(process.argv.slice(2)).catch((err) => {
  console.error(`[task-cli] Fatal: ${err?.message || err}`);
  process.exit(1);
});
