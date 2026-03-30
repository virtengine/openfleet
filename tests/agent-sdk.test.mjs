import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  hasCodexCliBinary,
  resolveAgentSdkModuleEntry,
  resolveCodexSdkInstall,
} from "../agent/agent-sdk.mjs";

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createCodexSdkInstall(rootDir, { withBinary }) {
  writeJson(join(rootDir, "package.json"), { name: "bosun-test-root", type: "module" });

  const sdkDir = join(rootDir, "node_modules", "@openai", "codex-sdk");
  mkdirSync(join(sdkDir, "dist"), { recursive: true });
  writeJson(join(sdkDir, "package.json"), {
    name: "@openai/codex-sdk",
    type: "module",
    exports: {
      ".": {
        import: "./dist/index.js",
      },
    },
  });
  writeFileSync(join(sdkDir, "dist", "index.js"), "export class Codex {}\n", "utf8");

  if (!withBinary) return;

  const binaryDir = join(
    rootDir,
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "codex",
  );
  mkdirSync(binaryDir, { recursive: true });
  writeFileSync(join(binaryDir, "codex.exe"), "", "utf8");
}

describe("agent-sdk module resolution", () => {
  it("prefers a complete Codex SDK install over a broken package tree", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bosun-agent-sdk-"));
    const brokenRoot = join(tempRoot, "broken");
    const healthyRoot = join(tempRoot, "healthy");
    mkdirSync(brokenRoot, { recursive: true });
    mkdirSync(healthyRoot, { recursive: true });

    try {
      createCodexSdkInstall(brokenRoot, { withBinary: false });
      createCodexSdkInstall(healthyRoot, { withBinary: true });

      expect(hasCodexCliBinary(brokenRoot, { platform: "win32", arch: "x64" })).toBe(false);
      expect(hasCodexCliBinary(healthyRoot, { platform: "win32", arch: "x64" })).toBe(true);

      const resolved = resolveCodexSdkInstall({
        extraRoots: [brokenRoot, healthyRoot],
        platform: "win32",
        arch: "x64",
      });

      expect(resolved).toBeTruthy();
      expect(resolved?.rootDir).toBe(healthyRoot);
      expect(resolved?.entryPath.replace(/\\/g, "/")).toMatch(/healthy\/node_modules\/@openai\/codex-sdk\/dist\/index\.js$/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves generic SDK module entries from explicit roots", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bosun-agent-sdk-entry-"));
    try {
      createCodexSdkInstall(tempRoot, { withBinary: true });
      const resolved = resolveAgentSdkModuleEntry("@openai/codex-sdk", {
        extraRoots: [tempRoot],
      });
      expect(resolved?.rootDir).toBe(tempRoot);
      expect(resolved?.entryPath.replace(/\\/g, "/")).toMatch(/node_modules\/@openai\/codex-sdk\/dist\/index\.js$/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
