import { beforeEach, describe, expect, it, vi } from "vitest";

let childProcessMocks;

async function loadDefinitionsWithChildProcessMocks() {
  childProcessMocks = {
    execFileSync: vi.fn(),
    execSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual("node:child_process");
    return {
      ...actual,
      execFileSync: childProcessMocks.execFileSync,
      execSync: childProcessMocks.execSync,
      spawn: childProcessMocks.spawn,
      spawnSync: childProcessMocks.spawnSync,
    };
  });
  return import("../workflow/workflow-nodes/definitions.mjs");
}

describe("execGitArgsSync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    childProcessMocks = null;
  });

  it("falls back to spawnSync when git execFileSync returns EPERM on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const { execGitArgsSync } = await loadDefinitionsWithChildProcessMocks();

    childProcessMocks.execFileSync.mockImplementation((cmd) => {
      if (cmd === "where.exe") {
        return "C:\\Program Files\\Git\\cmd\\git.exe\r\n";
      }
      if (String(cmd).toLowerCase().endsWith("\\git.exe")) {
        const error = new Error(`spawnSync ${cmd} EPERM`);
        error.code = "EPERM";
        throw error;
      }
      throw new Error(`unexpected execFileSync call: ${cmd}`);
    });

    childProcessMocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: "git version 2.52.0.windows.1\n",
      stderr: "",
      error: undefined,
    });

    const result = execGitArgsSync(["--version"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result).toBe("git version 2.52.0.windows.1\n");
    expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
      "C:\\Program Files\\Git\\cmd\\git.exe",
      ["--version"],
      expect.objectContaining({
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });
});
