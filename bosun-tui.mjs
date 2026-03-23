#!/usr/bin/env node

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import React from "react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readVersion() {
  return JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
}

function showHelp() {
  const version = readVersion();

  console.log(`
  bosun-tui v${version}
  Terminal User Interface for Bosun

  USAGE
    bosun-tui [options]

  OPTIONS
    --port <n>         UI server port to connect (default: 3080 or TELEGRAM_UI_PORT env)
    --host <host>      UI server host (default: localhost)
    --connect          Connect to existing UI server (don't start monitor)
    --screen <name>    Initial screen (tasks|agents|status)
    --refresh <ms>     Stats refresh interval (default: 2000ms)
    --help             Show this help
    --version          Show version
  `);
}

function getArgValue(flag, defaultValue = "") {
  const args = process.argv.slice(2);
  const match = args.find((arg) => arg.startsWith(`${flag}=`));
  if (match) return match.slice(flag.length + 1).trim();
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return defaultValue;
}

function getArgFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function ensureTty() {
  if (process.env.NODE_NO_TTY === "1" || !process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("[bosun-tui] Not a TTY");
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (getArgFlag("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  if (getArgFlag("--version") || args.includes("-v")) {
    console.log(`bosun-tui v${readVersion()}`);
    process.exit(0);
  }

  ensureTty();

  const port = Number(getArgValue("--port", process.env.TELEGRAM_UI_PORT || "3080")) || 3080;
  const host = getArgValue("--host", "localhost");
  const connectOnly = getArgFlag("--connect");
  const initialScreen = getArgValue("--screen", "status");
  const refreshMs = Number(getArgValue("--refresh", "2000")) || 2000;

  console.log("[bosun-tui] Starting...");
  console.log(`[bosun-tui] Connecting to ${host}:${port}`);

  try {
    const { render } = await import("ink");
    const { default: App } = await import("./tui/app.mjs");
    const app = render(
      React.createElement(App, {
        host,
        port,
        connectOnly,
        initialScreen,
        refreshMs,
      }),
    );
    await app.waitUntilExit();
  } catch (err) {
    console.error(`[bosun-tui] Failed to start: ${err.message}`);
    console.log("[bosun-tui] Ensure bosun is running or use --connect to connect to an existing UI server");
    process.exit(1);
  }
}

main();