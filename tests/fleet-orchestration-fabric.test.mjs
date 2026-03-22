import { describe, expect, it } from "vitest";
import {
  planMultiWorkspaceExecution,
  rebalancePlacementAfterPeerLoss,
} from "../agent/fleet-coordinator.mjs";

describe("fleet orchestration fabric", () => {
  it("honors explicit workspace and host placement preferences", () => {
    const tasks = [
      { id: "t1", title: "api", requiredWorkspace: "repo-a", requiredHost: "host-a" },
      { id: "t2", title: "web", requiredWorkspace: "repo-b" },
      { id: "t3", title: "ops", preferredHost: "host-c" },
    ];
    const peers = [
      { instance_id: "p1", host: "host-a", workspaceId: "repo-a", max_parallel: 2 },
      { instance_id: "p2", host: "host-b", workspaceId: "repo-b", max_parallel: 2 },
      { instance_id: "p3", host: "host-c", workspaceId: "repo-a", max_parallel: 2 },
    ];

    const result = planMultiWorkspaceExecution({ tasks, peers });
    const byTask = new Map(result.assignments.map((item) => [item.taskId, item]));

    expect(byTask.get("t1")).toMatchObject({ assignedTo: "p1", placementType: "required" });
    expect(byTask.get("t2")).toMatchObject({ assignedTo: "p2", placementType: "required" });
    expect(byTask.get("t3")).toMatchObject({ assignedTo: "p3", placementType: "preferred" });
  });

  it("falls back with recovery reasons when preferred placement is unavailable", () => {
    const tasks = [
      { id: "t1", title: "worker", preferredWorkspace: "repo-missing", preferredHost: "host-missing" },
    ];
    const peers = [
      { instance_id: "p1", host: "host-a", workspaceId: "repo-a", max_parallel: 1 },
    ];

    const result = planMultiWorkspaceExecution({ tasks, peers });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({
      assignedTo: "p1",
      placementType: "fallback",
      recoveryReason: "preferred-placement-unavailable",
    });
  });

  it("rebalances orphaned assignments onto remaining compatible peers", () => {
    const assignments = [
      { taskId: "t1", taskTitle: "api", assignedTo: "p1", wave: 1 },
      { taskId: "t2", taskTitle: "web", assignedTo: "p2", wave: 1 },
    ];
    const tasks = [
      { id: "t1", title: "api", requiredWorkspace: "repo-a" },
      { id: "t2", title: "web", requiredWorkspace: "repo-b" },
    ];
    const peers = [
      { instance_id: "p2", host: "host-b", workspaceId: "repo-b", max_parallel: 1 },
      { instance_id: "p3", host: "host-c", workspaceId: "repo-a", max_parallel: 2 },
    ];

    const result = rebalancePlacementAfterPeerLoss({
      assignments,
      peers,
      lostPeerIds: ["p1"],
      tasks,
    });

    expect(result.reassigned).toHaveLength(1);
    expect(result.reassigned[0]).toMatchObject({
      taskId: "t1",
      previousAssignedTo: "p1",
      assignedTo: "p3",
      recoveryReason: "peer-lost",
    });
    expect(result.unassigned).toEqual([]);
  });

  it("marks tasks unassigned when no compatible recovery target exists", () => {
    const assignments = [
      { taskId: "t1", taskTitle: "db", assignedTo: "p1", wave: 1 },
    ];
    const tasks = [
      { id: "t1", title: "db", requiredWorkspace: "repo-a", requiredHost: "host-a" },
    ];
    const peers = [
      { instance_id: "p2", host: "host-b", workspaceId: "repo-b", max_parallel: 1 },
    ];

    const result = rebalancePlacementAfterPeerLoss({
      assignments,
      peers,
      lostPeerIds: ["p1"],
      tasks,
    });

    expect(result.reassigned).toEqual([]);
    expect(result.unassigned).toHaveLength(1);
    expect(result.unassigned[0]).toMatchObject({
      taskId: "t1",
      previousAssignedTo: "p1",
      recoveryReason: "no-compatible-peer",
    });
  });
});
