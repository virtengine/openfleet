#!/usr/bin/env node

/**
 * bosun-tui — Terminal User Interface for Bosun
 *
 * A terminal-based UI for monitoring Bosun agents, tasks, and workflows.
 * Built with Ink (React-like CLI framework).
 *
 * Usage:
 *   bosun-tui              # Start the TUI
 *   bosun-tui --help       # Show help
 *   bosun-tui --port 3080  # Connect to specific port
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function showHelp() {
  const version = JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf8"),
  ).version;

  console.log(`
  bosun-tui v${version}
  Terminal User Interface for Bosun

  USAGE
    bosun-tui [options]

  OPTIONS
    --port <n>         UI server port to connect (default: 3080 or TELEGRAM_UI_PORT env)
    --host <host>     UI server host (default: localhost)
    --connect         Connect to existing UI server (don't start monitor)
    --screen <name>   Initial screen (tasks|agents|status)
    --refresh <ms>    Stats refresh interval (default: 2000ms)
    --help            Show this help
    --version         Show version

  SCREENS
    tasks    Kanban board with task CRUD
    agents   Live agent session table
    status   System status overview

  KEYBOARD NAVIGATION
    Tab / Shift+Tab   Navigate between panels
    ↑↓←→             Navigate within panels
    Enter            Select / Execute action
    Esc              Back / Close modal
    c                Create new task (tasks screen)
    r                Resume selected agent session (Agents screen)
    q                Quit

  EXAMPLES
    bosun-tui --port 3080
    bosun-tui --screen tasks
    bosun-tui --connect --port 3080
  `);
}

function getArgValue(flag, defaultValue = "") {
  const args = process.argv.slice(2);
  const match = args.find((arg) => arg.startsWith(`${flag}=`));
  if (match) {
    return match.slice(flag.length + 1).trim();
  }
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return defaultValue;
}

function getArgFlag(flag) {
  const args = process.argv.slice(2);
  return args.includes(flag);
}

async function main() {
  const args = process.argv.slice(2);

  if (getArgFlag("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  if (getArgFlag("--version") || args.includes("-v")) {
    const version = JSON.parse(
      readFileSync(resolve(__dirname, "package.json"), "utf8"),
    ).version;
    console.log(`bosun-tui v${version}`);
    process.exit(0);
  }

  const port = Number(getArgValue("--port", process.env.TELEGRAM_UI_PORT || "3080")) || 3080;
  const host = getArgValue("--host", "localhost");
  const connectOnly = getArgFlag("--connect");
  const initialScreen = getArgValue("--screen", "status");
  const refreshMs = Number(getArgValue("--refresh", "2000")) || 2000;

  console.log(`[bosun-tui] Starting...`);
  console.log(`[bosun-tui] Connecting to ${host}:${port}`);

  try {
    const { render } = await import("ink");
    const importErrors = [];

    let App;
    try {
      const appModule = await import("./tui/app.mjs");
      App = appModule.default;
    } catch (importErr) {
      importErrors.push(`App: ${importErr.message}`);
      console.error(`[bosun-tui] Failed to import TUI app: ${importErr.message}`);
      console.log(`[bosun-tui] TUI requires ink. Install with: npm install ink`);
      process.exit(1);
    }

    const { waitUntilExit } = await import("ink");

    const app = render(
      App({
        host,
        port,
        connectOnly,
        initialScreen,
        refreshMs,
      }),
    );

    process.exitCode = await waitUntilExit(app);
  } catch (err) {
    console.error(`[bosun-tui] Failed to start: ${err.message}`);
    console.log(`[bosun-tui] Ensure bosun is running or use --connect to connect to an existing UI server`);
    process.exit(1);
  }
}

main();
