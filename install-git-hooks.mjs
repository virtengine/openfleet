#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isEnvFlagEnabled, shouldAutoInstallGitHooks } from "./task-context.mjs";

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

function main() {
  if (isEnvFlagEnabled(process.env.BOSUN_SKIP_GIT_HOOKS, false)) {
    return;
  }
  if (!shouldAutoInstallGitHooks()) {
    return;
  }

  let root = "";
  try {
    root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return;
  }

  if (!root) return;

  const hooksDir = resolve(root, ".githooks");
  if (!existsSync(hooksDir)) {
    return;
  }

  run(`git -C "${root}" config core.hooksPath .githooks`);
  console.log(`[hooks] installed (core.hooksPath=.githooks)`);
}

main();
