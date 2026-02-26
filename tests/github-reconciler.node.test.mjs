import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setKanbanBackend, getKanbanAdapter } from "../kanban-adapter.mjs";
import { GitHubReconciler } from "../github-reconciler.mjs";

const ENV_KEYS = [
  "KANBAN_BACKEND",
  "GITHUB_PROJECT_MODE",
  "GITHUB_PROJECT_NUMBER",
  "GITHUB_PROJECT_ID",
  "GITHUB_REPOSITORY",
];

let envSnapshot = {};

function createGhResponder() {
  return async (args) => {
    const joined = args.join(" ");
    if (joined.includes("issue list") && joined.includes("--state open")) {
      return [
        {
          number: 42,
          title: "Task 42",
          labels: [{ name: "todo" }],
          url: "https://github.com/acme/widgets/issues/42",
        },
      ];
    }
    if (joined.includes("pr list") && joined.includes("--state open")) {
      return [];
    }
    if (joined.includes("pr list") && joined.includes("--state merged")) {
      return [];
    }
    if (joined.includes("issue list") && joined.includes("--state closed")) {
      return [];
    }
    throw new Error(`unexpected gh args: ${joined}`);
  };
}

describe("GitHubReconciler project status sync", () => {
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.KANBAN_BACKEND = "github";
    process.env.GITHUB_PROJECT_MODE = "kanban";
    process.env.GITHUB_PROJECT_NUMBER = "7";
    delete process.env.GITHUB_PROJECT_ID;
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    setKanbanBackend("github");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  it("prefers adapter.listTasks for project board status mapping", async () => {
    const adapter = getKanbanAdapter();
    let listTasksCalls = 0;
    let listTasksFromProjectCalls = 0;
    adapter.listTasks = async () => {
      listTasksCalls += 1;
      return [{ id: "42", status: "inprogress" }];
    };
    adapter.listTasksFromProject = async () => {
      listTasksFromProjectCalls += 1;
      throw new Error("should not be called when listTasks exists");
    };

    const updates = [];
    const reconciler = new GitHubReconciler({
      repoSlug: "acme/widgets",
      gh: createGhResponder(),
      addComment: async () => {},
      updateTaskStatus: async (issueNumber, status) => {
        updates.push([String(issueNumber), String(status)]);
      },
    });

    const summary = await reconciler.reconcileOnce();

    assert.equal(summary.status, "ok");
    assert.equal(summary.projectMismatches, 1);
    assert.equal(listTasksCalls, 1);
    assert.equal(listTasksFromProjectCalls, 0);
    assert.deepEqual(updates, [["42", "inprogress"]]);
  });

  it("falls back to listTasksFromProject when listTasks is unavailable", async () => {
    const adapter = getKanbanAdapter();
    adapter.listTasks = null;
    let listTasksFromProjectCalls = 0;
    adapter.listTasksFromProject = async () => {
      listTasksFromProjectCalls += 1;
      return [{ id: "42", status: "inreview" }];
    };

    const updates = [];
    const reconciler = new GitHubReconciler({
      repoSlug: "acme/widgets",
      gh: createGhResponder(),
      addComment: async () => {},
      updateTaskStatus: async (issueNumber, status) => {
        updates.push([String(issueNumber), String(status)]);
      },
    });

    const summary = await reconciler.reconcileOnce();

    assert.equal(summary.status, "ok");
    assert.equal(summary.projectMismatches, 1);
    assert.equal(listTasksFromProjectCalls, 1);
    assert.deepEqual(updates, [["42", "inreview"]]);
  });


  it("skips project board sync when adapter has no project-list APIs", async () => {
    const adapter = getKanbanAdapter();
    adapter.listTasks = null;
    adapter.listTasksFromProject = null;

    const updates = [];
    const reconciler = new GitHubReconciler({
      repoSlug: "acme/widgets",
      gh: createGhResponder(),
      addComment: async () => {},
      updateTaskStatus: async (issueNumber, status) => {
        updates.push([String(issueNumber), String(status)]);
      },
    });

    const summary = await reconciler.reconcileOnce();

    assert.equal(summary.status, "ok");
    assert.equal(summary.errors, 0);
    assert.equal(summary.projectMismatches, 0);
    assert.deepEqual(updates, []);
  });

  it("continues reconciliation when listTasks returns a non-iterable payload", async () => {
    const adapter = getKanbanAdapter();
    let listTasksCalls = 0;
    adapter.listTasks = async () => {
      listTasksCalls += 1;
      return { unexpected: true };
    };

    const updates = [];
    const reconciler = new GitHubReconciler({
      repoSlug: "acme/widgets",
      gh: createGhResponder(),
      addComment: async () => {},
      updateTaskStatus: async (issueNumber, status) => {
        updates.push([String(issueNumber), String(status)]);
      },
    });

    const summary = await reconciler.reconcileOnce();

    assert.equal(summary.status, "ok");
    assert.equal(summary.errors, 0);
    assert.equal(summary.projectMismatches, 0);
    assert.equal(listTasksCalls, 1);
    assert.deepEqual(updates, []);
  });

  it("continues reconciliation when project board listing fails", async () => {
    const adapter = getKanbanAdapter();
    let listTasksCalls = 0;
    adapter.listTasks = async () => {
      listTasksCalls += 1;
      throw new Error("project API unavailable");
    };

    const updates = [];
    const reconciler = new GitHubReconciler({
      repoSlug: "acme/widgets",
      gh: createGhResponder(),
      addComment: async () => {},
      updateTaskStatus: async (issueNumber, status) => {
        updates.push([String(issueNumber), String(status)]);
      },
    });

    const summary = await reconciler.reconcileOnce();

    assert.equal(summary.status, "ok");
    assert.equal(summary.errors, 0);
    assert.equal(summary.projectMismatches, 0);
    assert.equal(listTasksCalls, 1);
    assert.deepEqual(updates, []);
  });
});

