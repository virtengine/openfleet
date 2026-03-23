import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tui architecture scaffold", () => {
  const cwd = process.cwd();
  const cliSource = readFileSync(resolve(cwd, "cli.mjs"), "utf8");
  const entrySource = readFileSync(resolve(cwd, "bosun-tui.mjs"), "utf8");

  it("routes the `bosun tui` subcommand before generic help handling", () => {
    const tuiRoutingIndex = cliSource.indexOf('args[0] === "tui"');
    const helpIndex = cliSource.indexOf("// Handle --help");

    expect(tuiRoutingIndex).toBeGreaterThan(-1);
    expect(helpIndex).toBeGreaterThan(-1);
    expect(tuiRoutingIndex).toBeLessThan(helpIndex);
    expect(cliSource).toContain('await import("./bosun-tui.mjs")');
    expect(cliSource).toContain("await runBosunTui");
    expect(cliSource).toContain("tui                        Launch the terminal UI");
  });

  it("guards non-TTY output and wires resize-aware ink startup", () => {
    expect(entrySource).toContain("process.stdout.isTTY");
    expect(entrySource).toContain("loadConfig(");
    expect(entrySource).toContain('process.stdout.on("resize"');
    expect(entrySource).toContain("120");
    expect(entrySource).toContain("30");
    expect(entrySource).toContain('await import("./ui/tui/App.js")');
    expect(entrySource).toContain('await import("ink")');
  });

  it("defines the new ui/tui router and hooks", async () => {
    const constants = await import("../ui/tui/constants.js");
    const ws = await import("../ui/tui/useWebSocket.js");

    expect(constants.MIN_TERMINAL_SIZE).toEqual({ columns: 120, rows: 30 });
    expect(constants.TAB_ORDER.map((tab) => tab.id)).toEqual([
      "agents",
      "tasks",
      "logs",
      "workflows",
      "telemetry",
      "settings",
      "help",
    ]);
    expect(constants.TAB_ORDER.map((tab) => tab.shortcut)).toEqual([
      "a",
      "t",
      "l",
      "w",
      "x",
      "s",
      "?",
    ]);
    expect(ws.buildBusWebSocketUrl({ host: "127.0.0.1", port: 3080, token: "abc" })).toBe(
      "ws://127.0.0.1:3080/ws?token=abc",
    );
  });
});
