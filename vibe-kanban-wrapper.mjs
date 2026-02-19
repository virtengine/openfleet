#!/usr/bin/env node
/**
 * vibe-kanban-wrapper.mjs - Wrapper to expose bundled vibe-kanban CLI
 *
 * This wrapper ensures the bundled vibe-kanban CLI is available when
 * @virtengine/openfleet is installed globally. npm doesn't expose
 * bins from transitive dependencies, so we need this proxy.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the bundled vibe-kanban CLI
const vkBin = resolve(
  __dirname,
  "node_modules",
  "vibe-kanban",
  "bin",
  "cli.js",
);

// Forward all args to the bundled vibe-kanban
const args = process.argv.slice(2);
const child = spawn("node", [vkBin, ...args], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    // Prevent git from opening interactive editors (blocks agents if AFK)
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  },
});

child.on("exit", (code) => {
  process.exit(code || 0);
});
