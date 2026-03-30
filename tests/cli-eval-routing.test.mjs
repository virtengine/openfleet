import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli eval routing", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

  it("routes eval subcommands before global help handling", () => {
    const evalRoutingIndex = cliSource.indexOf("const evalFlagIndex = args.indexOf(\"--eval\")");
    const helpRoutingIndex = cliSource.indexOf("// Handle --help");

    expect(evalRoutingIndex).toBeGreaterThan(-1);
    expect(helpRoutingIndex).toBeGreaterThan(-1);
    expect(evalRoutingIndex).toBeLessThan(helpRoutingIndex);
    expect(cliSource).toContain("args.indexOf(\"eval\")");
    expect(cliSource).toContain("const evalArgs = args.slice(commandStartIndex + 1)");
    expect(cliSource).toContain('const { runEvalCli } = await import("./bench/eval-framework.mjs")');
    expect(cliSource).toContain("const { exitCode } = await runEvalCli(evalArgs)");
    expect(cliSource).toContain("process.exit(exitCode)");
  });

  it("documents eval commands in help output", () => {
    expect(cliSource).toContain("eval <command>             Run agent evaluation and benchmarking tools");
    expect(cliSource).toContain("Run 'bosun eval --help' for evaluation CLI examples.");
  });
});
