import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTemplate } from "../workflow-templates.mjs";

const source = readFileSync(
  resolve(process.cwd(), "task-executor.mjs"),
  "utf8",
);

describe("task-executor orphan recovery migration", () => {
  it("removes legacy orphan recovery execution from task-executor startup", () => {
    assert.equal(
      source.includes("this._recoverOrphanedWorktrees().catch"),
      false,
      "task-executor start() should not run orphan recovery directly",
    );
  });

  it("does not include banned --no-verify runtime commit path", () => {
    assert.equal(
      source.includes("--no-verify"),
      false,
      "legacy runtime orphan recovery commit path must not use --no-verify",
    );
  });

  it("removes legacy orphan recovery method implementation", () => {
    assert.equal(
      source.includes("async _recoverOrphanedWorktrees("),
      false,
      "task-executor should not retain legacy orphan recovery method",
    );
  });

  it("provides dedicated workflow replacement template", () => {
    const template = getTemplate("template-task-orphan-worktree-recovery");
    assert.ok(template, "workflow replacement template should exist");
    assert.equal(template.trigger, "trigger.schedule");
    assert.equal(template.category, "reliability");
    assert.equal(template.metadata?.replaces?.module, "task-executor.mjs");
    assert.ok(
      template.metadata?.replaces?.functions?.includes("_recoverOrphanedWorktrees"),
      "workflow template should declare _recoverOrphanedWorktrees replacement",
    );
  });
});
