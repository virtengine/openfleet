import { describe, expect, it } from "vitest";
import { VeKanbanRuntime, parseKanbanCommand } from "../ve-kanban.mjs";

describe("ve-kanban native cli", () => {
  it("parses command and args", () => {
    expect(parseKanbanCommand([])).toEqual({ command: "help", args: [] });
    expect(parseKanbanCommand(["list", "--status", "todo"])).toEqual({
      command: "list",
      args: ["--status", "todo"],
    });
  });

  it("submits attempt using detected project/repo IDs", async () => {
    const calls = [];
    const mockFetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (String(url).includes("/api/projects")) {
        return {
          ok: true,
          text: async () => JSON.stringify([{ id: "proj-1", name: "virtengine" }]),
        };
      }
      if (String(url).includes("/api/repos")) {
        return {
          ok: true,
          text: async () => JSON.stringify([{ id: "repo-1", name: "virtengine" }]),
        };
      }
      if (String(url).includes("/api/task-attempts")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: "attempt-1", branch: "ve/test" }),
        };
      }
      return {
        ok: false,
        text: async () => JSON.stringify({ message: "unexpected" }),
      };
    };

    const runtime = new VeKanbanRuntime({
      fetchImpl: mockFetch,
      env: {
        VK_BASE_URL: "http://vk.local",
        VK_PROJECT_NAME: "virtengine",
        GH_REPO: "virtengine",
      },
      executorStatePath: "/tmp/nonexistent-ve-kanban-state.json",
    });

    const result = await runtime.submitTaskAttempt("task-1", {
      executorOverride: { executor: "CODEX", variant: "DEFAULT" },
    });

    expect(result.id).toBe("attempt-1");
    const submitCall = calls.find((entry) =>
      String(entry.url).includes("/api/task-attempts"),
    );
    expect(submitCall).toBeTruthy();
    const body = JSON.parse(submitCall.options.body);
    expect(body.task_id).toBe("task-1");
    expect(body.repos[0].repo_id).toBe("repo-1");
    expect(body.executor_profile_id).toEqual({
      executor: "CODEX",
      variant: "DEFAULT",
    });
  });
});
