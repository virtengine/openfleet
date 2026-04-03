import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: childProcessMocks.execFileSync,
    execSync: childProcessMocks.execSync,
    spawn: childProcessMocks.spawn,
    spawnSync: childProcessMocks.spawnSync,
  };
});

const { execGitArgsSync } = await import("../workflow/workflow-nodes/definitions.mjs");

describe("execGitArgsSync", () => {
  beforeEach(() => {
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.execSync.mockReset();
    childProcessMocks.spawn.mockReset();
    childProcessMocks.spawnSync.mockReset();
  });

  it("falls back to spawnSync when git execFileSync returns EPERM on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

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
