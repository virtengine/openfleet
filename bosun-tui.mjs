#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import loadConfig from "./config/config.mjs";
import { resolveWebSocketProtocol } from "./tui/lib/ws-bridge.mjs";

const MIN_COLUMNS = 120;
const MIN_ROWS = 30;


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function showHelp() {
  const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
  console.log(`
  bosun-tui v${version}
  Terminal UI for Bosun

  USAGE
    bosun tui [options]
    node bosun-tui.mjs [options]

  OPTIONS
    --host <host>       WebSocket host (default: 127.0.0.1)
    --port <n>          WebSocket/UI port (default: TELEGRAM_UI_PORT or 3080)
    --screen <name>     Initial screen (agents|tasks|logs|workflows|telemetry|settings|help)
    --help              Show this help
    --version           Show version
  `);
}

function getArgValue(args, flag, defaultValue = "") {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1).trim();
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1].trim();
  }
  return defaultValue;
}

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function getTerminalSize(stdout = process.stdout) {
  return {
    columns: Math.max(0, Number(stdout?.columns || 0)),
    rows: Math.max(0, Number(stdout?.rows || 0)),
  };
}

function resolvePort(config) {
  return Number(process.env.TELEGRAM_UI_PORT || process.env.BOSUN_PORT || config?.telegramUiPort || "3080") || 3080;
}

function renderApp(instance, React, App, props) {
  instance.rerender(React.createElement(App, props));
}

export async function runBosunTui(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv : [];

  if (hasFlag(args, "--help", "-h")) {
    showHelp();
    return 0;
  }

  if (hasFlag(args, "--version", "-v")) {
    const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
    console.log(`bosun-tui v${version}`);
    return 0;
  }

  if (!stdout?.isTTY) {
    stderr.write("[bosun-tui] Error: stdout is not a TTY. Run `bosun tui` in an interactive terminal.\n");
    return 1;
  }

  globalThis.WebSocket = globalThis.WebSocket || (await import("ws")).WebSocket;

  const config = loadConfig([process.argv[0], __filename, ...args]);
  const configDir = String(config?.configDir || process.env.BOSUN_DIR || resolve(process.cwd(), ".bosun")).trim();
  const host = getArgValue(args, "--host", "127.0.0.1");
  const port = Number(getArgValue(args, "--port", String(resolvePort(config)))) || resolvePort(config);
  const protocol = getArgValue(
    args,
    "--protocol",
    resolveWebSocketProtocol({ configDir }),
  );
  const initialScreen = getArgValue(args, "--screen", "agents");

  const React = await import("react");
  const ink = await import("ink");
  const { default: App } = await import("./ui/tui/App.js");

  let terminalSize = getTerminalSize(stdout);
  const props = {
    config,
    configDir,
    host,
    port,
    protocol,
    initialScreen,
    terminalSize,
  };

  const instance = ink.render(React.createElement(App, props), { exitOnCtrlC: true });

  const onResize = () => {
    terminalSize = getTerminalSize(stdout);
    renderApp(instance, React, App, { ...props, terminalSize });
  };

  stdout.on?.("resize", onResize);

  try {
    if (typeof instance.waitUntilExit === "function") {
      await instance.waitUntilExit();
    }
    return 0;
  } finally {
    stdout.off?.("resize", onResize);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runBosunTui(process.argv.slice(2))
    .then((code) => {
      process.exit(code ?? 0);
    })
    .catch((error) => {
      console.error(`[bosun-tui] Failed to start: ${error?.message || error}`);
      process.exit(1);
    });
}


