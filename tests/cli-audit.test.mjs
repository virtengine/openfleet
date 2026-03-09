import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli audit wiring", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

  it("documents the audit subcommand in help output", () => {
    expect(cliSource).toContain("audit <subcommand>");
    expect(cliSource).toContain("Run codebase annotation audit workflows");
  });

  it("routes the audit subcommand through tools/codebase-audit.mjs", () => {
    expect(cliSource).toContain('if (args[0] === "audit" || args.includes("--audit"))');
    expect(cliSource).toContain('await import("./tools/codebase-audit.mjs")');
    expect(cliSource).toContain('const exitCode = await runAuditCli(auditArgs);');
  });

  it("publishes the audit module and skill asset", () => {
    expect(packageJson.exports["./audit"]).toBe("./tools/codebase-audit.mjs");
    expect(packageJson.scripts["audit:ci"]).toBe("node cli.mjs audit --ci");
    expect(packageJson.files).toContain("tools/codebase-audit.mjs");
    expect(packageJson.files).toContain("agent/skill-codebase-audit.md");
  });
});
