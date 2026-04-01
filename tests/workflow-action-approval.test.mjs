import { describe, expect, it } from "vitest";

import { describeRiskyWorkflowAction } from "../workflow/action-approval.mjs";

describe("workflow action approvals", () => {
  it("classifies targeted irreversible workflow actions", () => {
    expect(describeRiskyWorkflowAction({
      nodeType: "action.push_branch",
      nodeConfig: { branch: "feat/demo", remote: "origin" },
    })).toMatchObject({
      actionKey: "push-branch",
      actionLabel: "Push branch",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.create_pr",
      nodeConfig: { title: "feat: ship it" },
    })).toMatchObject({
      actionKey: "create-pr",
      actionLabel: "Create pull request",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.git_operations",
      nodeConfig: { operations: [{ op: "commit" }, { op: "push" }] },
    })).toMatchObject({
      actionKey: "git-operations-push",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.refresh_worktree",
      nodeConfig: { operation: "reset_hard" },
    })).toMatchObject({
      actionKey: "refresh-worktree-reset-hard",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.bosun_cli",
      nodeConfig: { subcommand: "task delete", args: "--id T-1" },
    })).toMatchObject({
      actionKey: "bosun-cli-task-delete",
    });
  });

  it("matches only the intended dangerous shell commands for action.run_command", () => {
    expect(describeRiskyWorkflowAction({
      nodeType: "action.run_command",
      command: "git",
      args: ["push", "--force-with-lease"],
    })).toMatchObject({
      actionKey: "run-command-git-push",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.run_command",
      command: "git reset --hard HEAD && git clean -fd",
    })).toMatchObject({
      actionKey: "run-command-git-reset-hard",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.run_command",
      command: "gh",
      args: ["pr", "close", "42", "--delete-branch"],
    })).toMatchObject({
      actionKey: "run-command-gh-pr-close",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.run_command",
      command: "npm",
      args: ["publish"],
    })).toMatchObject({
      actionKey: "run-command-npm-publish",
    });

    expect(describeRiskyWorkflowAction({
      nodeType: "action.run_command",
      command: "echo git push",
    })).toBeNull();
  });
});
