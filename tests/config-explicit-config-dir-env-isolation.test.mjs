import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("config explicit config-dir env isolation", () => {
  const source = readFileSync(resolve(process.cwd(), "config/config.mjs"), "utf8");

  it("does not load repo-root .env by default when config-dir is explicit", () => {
    expect(source).toContain("const explicitConfigDirRaw =");
    expect(source).toContain("const shouldLoadRepoEnv =");
    expect(source).toContain("!hasExplicitConfigDir || allowRepoEnvWithExplicitConfig");
    expect(source).toContain("process.env.BOSUN_LOAD_REPO_ENV_WITH_EXPLICIT_CONFIG");
  });

  it("limits kanban env source detection to loaded env paths", () => {
    expect(source).toContain("const envPaths = [resolve(configDir, \".env\")];");
    expect(source).toContain("if (shouldLoadRepoEnv) {");
    expect(source).toContain("envPaths.push(resolve(repoRoot, \".env\"));");
  });
});
