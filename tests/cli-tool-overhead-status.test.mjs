import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli tool overhead status", () => {
  it("shows tool overhead totals and warnings in workspace status", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "bosun-tool-overhead-"));
    const bosunDir = resolve(rootDir, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    writeFileSync(resolve(bosunDir, "bosun.config.json"), JSON.stringify({ workspaces: [] }), "utf8");
    writeFileSync(
      resolve(bosunDir, "agent-tools.json"),
      JSON.stringify({
        agents: {
          primary: {
            enabledMcpServers: ["huge-server"],
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        },
        defaults: { builtinTools: ["search-files"], updatedAt: "2026-03-25T00:00:00.000Z" },
        toolOverhead: {
          primary: {
            total: 23456,
            bySource: {
              builtin: 3456,
              "huge-server": 20000,
            },
          },
        },
      }),
      "utf8",
    );

    try {
      const output = execFileSync(process.execPath, ["cli.mjs", "--workspace-status", "--config-dir", bosunDir], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(output).toContain("Tool Overhead:");
      expect(output).toContain("Total tool chars: 23,456");
      expect(output).toContain("builtin: 3,456 chars");
      expect(output).toContain("huge-server: 20,000 chars");
      expect(output).toContain("WARNING");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
