import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCopilotCliLaunchConfig } from "../shell/copilot-shell.mjs";

describe("resolveCopilotCliLaunchConfig", () => {
  const copilotShellSource = readFileSync(
    resolve(process.cwd(), "shell/copilot-shell.mjs"),
    "utf8",
  );

  it("prefers an explicit CLI path from the environment", () => {
    const config = resolveCopilotCliLaunchConfig({
      env: { COPILOT_CLI_PATH: "C:/custom/copilot.exe" },
      cliArgs: ["--allow-all"],
      fileExists: () => true,
      execPath: "node",
      repoRoot: "C:/repo",
    });

    expect(config).toEqual({
      cliPath: "C:/custom/copilot.exe",
      cliArgs: ["--allow-all"],
      source: "env",
    });
  });

  it("uses the bundled CLI loader when no explicit path is set", () => {
    const config = resolveCopilotCliLaunchConfig({
      env: {},
      cliArgs: ["--allow-all"],
      fileExists: (path) => path.endsWith("node_modules\\@github\\copilot\\npm-loader.js") || path.endsWith("node_modules/@github/copilot/npm-loader.js"),
      execPath: "node",
      repoRoot: "C:/repo",
    });

    expect(config).toEqual({
      cliPath: "node",
      cliArgs: [
        expect.stringMatching(/node_modules[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/),
        "--allow-all",
      ],
      source: "bundled",
    });
  });

  it("falls back to PATH lookup when no explicit or bundled CLI exists", () => {
    const config = resolveCopilotCliLaunchConfig({
      env: {},
      cliArgs: ["--allow-all"],
      fileExists: () => false,
      execPath: "node",
      repoRoot: "C:/repo",
    });

    expect(config).toEqual({
      cliPath: undefined,
      cliArgs: ["--allow-all"],
      source: "path",
    });
  });

  it("defaults to Bosun-managed MCP servers only", () => {
    expect(copilotShellSource).toContain("function shouldAllowExternalMcpSources");
    expect(copilotShellSource).toContain("if (!shouldAllowExternalMcpSources()) {");
    expect(copilotShellSource).toContain("return libraryServers;");
    expect(copilotShellSource).toContain("Bosun-managed MCP server(s)");
  });
});
