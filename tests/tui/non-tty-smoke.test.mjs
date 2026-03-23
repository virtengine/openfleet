import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("bosun-tui non-tty smoke", () => {
  it("exits with a friendly Not a TTY message", async () => {
    const scriptPath = resolve(process.cwd(), "bosun-tui.mjs");

    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_NO_TTY: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolveResult({ code, stdout, stderr });
      });
    });

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Not a TTY");
  });
});