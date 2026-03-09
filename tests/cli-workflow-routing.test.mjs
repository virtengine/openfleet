import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli workflow routing", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

  it("documents workflow commands in the top-level help", () => {
    expect(cliSource).toContain("WORKFLOWS");
    expect(cliSource).toContain("workflow list");
    expect(cliSource).toContain("Run 'bosun workflow --help' for workflow CLI details.");
  });

  it("routes workflow subcommands before generic help handling", () => {
    const workflowRoutingIndex = cliSource.indexOf('const workflowFlagIndex = args.indexOf("--workflow")');
    const helpIndex = cliSource.indexOf("// Handle --help");

    expect(workflowRoutingIndex).toBeGreaterThan(-1);
    expect(helpIndex).toBeGreaterThan(-1);
    expect(workflowRoutingIndex).toBeLessThan(helpIndex);
    expect(cliSource).toContain('args[0] === "workflow"');
    expect(cliSource).toContain('const { runWorkflowCli } = await import("./workflow/workflow-cli.mjs")');
    expect(cliSource).toContain('const workflowArgs = args.slice(commandStartIndex + 1)');
  });
});
