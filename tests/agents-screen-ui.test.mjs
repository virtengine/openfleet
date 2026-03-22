import { describe, expect, it } from "vitest";
import {
	buildAgentsViewModel,
	buildKillConfirmationLabel,
	buildOsc52Sequence,
	buildSessionCommand,
	getStatusColor,
	pruneCompletedSessions,
	selectNextIndex,
} from "../ui/tui/AgentsScreen.js";

describe("AgentsScreen helpers", () => {
	it("maps status colors from stage and status values", () => {
		expect(getStatusColor("running")).toBe("green");
		expect(getStatusColor("queued")).toBe("yellow");
		expect(getStatusColor("stuck")).toBe("red");
		expect(getStatusColor("rework")).toBe("magenta");
		expect(getStatusColor("paused")).toBe("gray");
	});

	it("clamps keyboard selection movement", () => {
		expect(selectNextIndex(0, -1, 3)).toBe(0);
		expect(selectNextIndex(1, 1, 3)).toBe(2);
		expect(selectNextIndex(2, 1, 3)).toBe(2);
		expect(selectNextIndex(5, 0, 2)).toBe(1);
	});

	it("retains completed sessions for 10 seconds only", () => {
		const now = Date.parse("2026-03-22T12:00:00.000Z");
		const sessions = [
			{ id: "active-1", status: "running" },
			{ id: "done-keep", status: "completed", endedAt: "2026-03-22T11:59:55.000Z" },
			{ id: "done-drop", status: "completed", endedAt: "2026-03-22T11:59:49.000Z" },
		];
		const kept = pruneCompletedSessions(sessions, now);
		expect(kept.map((session) => session.id)).toEqual(["active-1", "done-keep"]);
	});

	it("builds a sorted live view model with formatted fields and backoff countdown", () => {
		const now = Date.parse("2026-03-22T12:00:00.000Z");
		const { sessions, backoffQueue } = buildAgentsViewModel({
			now,
			sessions: [
				{
					id: "older-session-id",
					status: "paused",
					stage: "paused",
					startedAt: "2026-03-22T11:55:00.000Z",
					event: "older event",
				},
				{
					id: "newer-session-id",
					status: "running",
					stage: "running",
					startedAt: "2026-03-22T11:59:00.000Z",
					turn: 3,
					usage: { totalTokens: 12345 },
					sessionLabel: "codex-main",
					pid: 8844,
					event: "A very long event message that should remain available in full on the view model",
				},
			],
			backoffQueue: [
				{ taskId: "task-1", attempt: 2, nextRetryAt: "2026-03-22T12:00:05.000Z" },
			],
		});

		expect(sessions).toHaveLength(2);
		expect(sessions[0].id).toBe("newer-session-id");
		expect(sessions[0].idShort).toBe("newer-se");
		expect(sessions[0].stageText.trim()).toBe("running");
		expect(sessions[0].tokensText.trim()).toBe("12,345");
		expect(sessions[0].ageTurn.trim()).toBe("1m00s/3");
		expect(sessions[0].statusColor).toBe("green");
		expect(sessions[0].eventText).toContain("A very long event");
		expect(backoffQueue).toEqual([{ id: "task-1", attempt: 2, countdown: "5s" }]);
	});

	it("builds kill labels, OSC52 payloads, and ws command envelopes", () => {
		expect(buildKillConfirmationLabel({ id: "MT-734f9abc" })).toBe("Kill MT-734f9? [y/N]");
		expect(buildOsc52Sequence("session-uuid")).toBe("\u001b]52;c;c2Vzc2lvbi11dWlk\u0007");
		expect(buildSessionCommand("kill", { id: "abc", sessionId: "uuid", pid: 99, turn: 4 })).toEqual({
			type: "session:kill",
			payload: { id: "abc", sessionId: "uuid", pid: 99, turn: 4 },
		});
	});
});
