import { describe, expect, it } from "vitest";
import {
  isAbsoluteWorkspaceHealthPath,
  normalizeWorkspaceHealthPath,
  writableRootContainsPath,
} from "../config/workspace-health.mjs";

describe("workspace-health sandbox path helpers", () => {
  it("treats Windows drive roots as absolute", () => {
    expect(isAbsoluteWorkspaceHealthPath("C:\\Users\\jON\\.codex")).toBe(true);
  });

  it("treats UNC paths as absolute", () => {
    expect(isAbsoluteWorkspaceHealthPath("\\\\server\\share\\bosun")).toBe(true);
  });

  it("normalizes Windows paths case-insensitively", () => {
    expect(normalizeWorkspaceHealthPath("C:\\Users\\jON\\Repo")).toBe(
      normalizeWorkspaceHealthPath("c:/Users/jON/Repo"),
    );
  });

  it("detects when a writable root covers a nested git directory", () => {
    expect(
      writableRootContainsPath(
        "C:\\Users\\jON\\workspace",
        "c:\\Users\\jON\\workspace\\bosun\\.git",
      ),
    ).toBe(true);
  });

  it("does not match sibling paths", () => {
    expect(
      writableRootContainsPath(
        "C:\\Users\\jON\\workspace",
        "C:\\Users\\jON\\workspace-other\\.git",
      ),
    ).toBe(false);
  });
});
