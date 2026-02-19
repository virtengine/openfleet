import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  formatOrchestratorScriptForEnv,
  getDefaultOrchestratorScripts,
  getScriptRuntimePrerequisiteStatus,
  resolveSetupOrchestratorDefaults,
} from "../setup.mjs";

async function createScriptPair(dir, ext) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `ve-orchestrator.${ext}`), "#!/usr/bin/env stub\n");
  await writeFile(resolve(dir, `ve-kanban.${ext}`), "#!/usr/bin/env stub\n");
}

describe("setup platform defaults", () => {
  it("prefers .ps1 defaults on win32", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "openfleet-setup-platform-"));

    try {
      await createScriptPair(dir, "ps1");
      await createScriptPair(dir, "sh");

      const result = getDefaultOrchestratorScripts("win32", dir);
      expect(result.preferredExt).toBe("ps1");
      expect(result.selectedDefault?.ext).toBe("ps1");
      expect(result.variants.map((variant) => variant.ext)).toEqual([
        "ps1",
        "sh",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers .sh defaults on linux", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "openfleet-setup-platform-"));

    try {
      await createScriptPair(dir, "ps1");
      await createScriptPair(dir, "sh");

      const result = getDefaultOrchestratorScripts("linux", dir);
      expect(result.preferredExt).toBe("sh");
      expect(result.selectedDefault?.ext).toBe("sh");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to available variant when preferred one is missing", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "openfleet-setup-platform-"));

    try {
      await createScriptPair(dir, "ps1");

      const result = getDefaultOrchestratorScripts("darwin", dir);
      expect(result.preferredExt).toBe("sh");
      expect(result.selectedDefault?.ext).toBe("ps1");
      expect(result.variants).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses pwsh as required runtime on win32", () => {
    const checker = (cmd) => cmd === "pwsh";
    const result = getScriptRuntimePrerequisiteStatus("win32", checker);

    expect(result.required.label).toBe("PowerShell (pwsh)");
    expect(result.required.ok).toBe(true);
    expect(result.optionalPwsh).toBeNull();
  });

  it("uses bash as required runtime and pwsh as optional on linux", () => {
    const checker = (cmd) => cmd === "bash";
    const result = getScriptRuntimePrerequisiteStatus("linux", checker);

    expect(result.required.label).toBe("bash");
    expect(result.required.ok).toBe(true);
    expect(result.optionalPwsh?.label).toBe("PowerShell (pwsh)");
    expect(result.optionalPwsh?.ok).toBe(false);
  });

  it("formats default orchestrator script as config-relative path", () => {
    const scriptPath = "/tmp/project/scripts/openfleet/ve-orchestrator.sh";
    const configDir = "/tmp/project/scripts/openfleet";
    expect(formatOrchestratorScriptForEnv(scriptPath, configDir)).toBe(
      "./ve-orchestrator.sh",
    );
  });

  it("resolves setup defaults and emits relative .sh path on non-windows", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "openfleet-setup-repo-"));
    const packageDir = await mkdtemp(resolve(tmpdir(), "openfleet-setup-pkg-"));
    const configDir = resolve(repoRoot, "scripts", "openfleet");

    try {
      await createScriptPair(configDir, "sh");
      await createScriptPair(configDir, "ps1");
      await createScriptPair(packageDir, "sh");
      await createScriptPair(packageDir, "ps1");

      const result = resolveSetupOrchestratorDefaults({
        platform: "linux",
        repoRoot,
        configDir,
        packageDir,
      });

      expect(result.selectedDefault?.ext).toBe("sh");
      expect(result.orchestratorScriptEnvValue).toBe("./ve-orchestrator.sh");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(packageDir, { recursive: true, force: true });
    }
  });
});
