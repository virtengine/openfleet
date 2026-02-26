import { describe, expect, it } from "vitest";
import {
  appendBosunCoAuthor,
  buildCommitMessage,
  shouldAddBosunCoAuthor,
} from "../git-commit-helpers.mjs";

describe("git-commit-helpers", () => {
  it("appendBosunCoAuthor is idempotent", () => {
    const first = appendBosunCoAuthor("feat(core): example");
    const second = appendBosunCoAuthor(first);
    expect(second).toBe(first);
  });

  it("buildCommitMessage is task-scoped by default", () => {
    const noTask = buildCommitMessage("feat(core): scoped message", "body", {
      env: {},
    });
    expect(noTask).not.toContain("Co-authored-by: bosun-ve[bot]");

    const withTask = buildCommitMessage("feat(core): scoped message", "body", {
      env: { VE_TASK_ID: "task-1", VE_MANAGED: "1" },
    });
    expect(withTask).toContain("Co-authored-by: bosun-ve[bot]");
  });

  it("buildCommitMessage honors explicit addBosunCredit option", () => {
    const forced = buildCommitMessage("fix(core): explicit", "", {
      addBosunCredit: true,
      env: {},
    });
    expect(forced).toContain("Co-authored-by: bosun-ve[bot]");

    const suppressed = buildCommitMessage("fix(core): explicit", "", {
      addBosunCredit: false,
      env: { VE_TASK_ID: "task-2", VE_MANAGED: "1" },
    });
    expect(suppressed).not.toContain("Co-authored-by: bosun-ve[bot]");
  });

  it("exposes co-author mode behavior via helper", () => {
    expect(shouldAddBosunCoAuthor({ env: {} })).toBe(false);
    expect(
      shouldAddBosunCoAuthor({
        env: { BOSUN_COAUTHOR_MODE: "always" },
      }),
    ).toBe(true);
    expect(
      shouldAddBosunCoAuthor({
        env: { BOSUN_COAUTHOR_MODE: "off" },
      }),
    ).toBe(false);
  });
});

