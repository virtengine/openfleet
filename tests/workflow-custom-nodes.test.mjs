import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ensureWorkflowNodeTypesLoaded,
  getNodeType,
  listNodeTypes,
  scaffoldCustomNodeFile,
  stopCustomNodeDiscovery,
  unregisterNodeType,
} from "../workflow/workflow-nodes.mjs";

let repoRoot;

function makeRepoRoot() {
  repoRoot = mkdtempSync(join(tmpdir(), "bosun-custom-node-test-"));
  mkdirSync(join(repoRoot, "custom-nodes"), { recursive: true });
  return repoRoot;
}

afterEach(() => {
  stopCustomNodeDiscovery();
  if (repoRoot) {
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ok */ }
  }
  repoRoot = null;
});

describe("custom workflow nodes", () => {
  it("loads a scaffolded custom node and exposes palette metadata", async () => {
    const root = makeRepoRoot();
    const result = scaffoldCustomNodeFile("my-notifier", { repoRoot: root });
    expect(existsSync(result.filePath)).toBe(true);

    await ensureWorkflowNodeTypesLoaded({ repoRoot: root, forceReload: true });
    const handler = getNodeType(result.type);
    expect(handler).toBeDefined();
    const output = await handler.execute({ id: "n1", config: { message: "hi" } }, { log() {} });
    expect(output.success).toBe(true);

    const meta = listNodeTypes().find((entry) => entry.type === result.type);
    expect(meta?.isCustom).toBe(true);
    expect(meta?.badge).toBe("custom");
    unregisterNodeType(result.type);
  });

  it("skips invalid custom nodes with a warning", async () => {
    const root = makeRepoRoot();
    writeFileSync(join(root, "custom-nodes", "broken.mjs"), 'export const type = "custom.broken";\nexport const inputs = [];\nexport const outputs = [];\nexport function describe(){ return "broken"; }\n', "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureWorkflowNodeTypesLoaded({ repoRoot: root, forceReload: true });

    expect(getNodeType("custom.broken")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips duplicate custom node types with a warning", async () => {
    const root = makeRepoRoot();
    writeFileSync(join(root, "custom-nodes", "alpha.mjs"), [
      'export const type = "custom.same";',
      "export const inputs = [];",
      "export const outputs = [];",
      "export function describe(){ return 'alpha'; }",
      "export async function execute(){ return { success: true, port: 'default' }; }",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "custom-nodes", "bravo.mjs"), [
      'export const type = "custom.same";',
      "export const inputs = [];",
      "export const outputs = [];",
      "export function describe(){ return 'bravo'; }",
      "export async function execute(){ return { success: true, port: 'default' }; }",
      "",
    ].join("\n"), "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureWorkflowNodeTypesLoaded({ repoRoot: root, forceReload: true });

    expect(getNodeType("custom.same")).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    unregisterNodeType("custom.same");
  });

  it("skips custom nodes with invalid schema shape", async () => {
    const root = makeRepoRoot();
    writeFileSync(join(root, "custom-nodes", "bad-schema.mjs"), [
      'export const type = "custom.bad_schema";',
      "export const inputs = [];",
      "export const outputs = [];",
      "export const schema = { type: 'array' };",
      "export function describe(){ return 'bad schema'; }",
      "export async function execute(){ return { success: true, port: 'default' }; }",
      "",
    ].join("\n"), "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureWorkflowNodeTypesLoaded({ repoRoot: root, forceReload: true });

    expect(getNodeType("custom.bad_schema")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("scaffolds custom nodes from the CLI", () => {
    const root = makeRepoRoot();
    const cliPath = resolve(process.cwd(), "cli.mjs");
    execFileSync(process.execPath, [cliPath, "node:create", "my-cli-node"], {
      cwd: process.cwd(),
      env: { ...process.env, REPO_ROOT: root, NODE_ENV: "test" },
      stdio: "pipe",
    });

    const filePath = join(root, "custom-nodes", "my-cli-node.mjs");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain('export const type = "custom.my_cli_node"');
  });
});
