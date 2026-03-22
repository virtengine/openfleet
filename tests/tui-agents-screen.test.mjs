import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
	buildAgentsViewModel,
	buildKillConfirmationLabel,
	buildOsc52Sequence,
	buildSessionCommand,
	getStatusColor,
	pruneCompletedSessions,
	selectNextIndex,
} from "../tui/screens/agents-helpers.mjs";

describe("tui agents screen helpers", () => {
	it("sorts newest sessions first and keeps completed entries briefly", () => {
		const now = Date.parse("2026-03-22T12:00:10.000Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const sessions = [
			{
				id: "session-old",
				status: "active",
				startedAt: "2026-03-22T12:00:00.000Z",
			},
			{
				id: "session-new",
				status: "running",
				startedAt: "2026-03-22T12:00:09.000Z",
			},
			{
				id: "session-done",
				status: "completed",
				startedAt: "2026-03-22T11:59:00.000Z",
				endedAt: "2026-03-22T12:00:05.000Z",
			},
		];

		expect(pruneCompletedSessions(sessions, now).map((item) => item.id)).toEqual([
			"session-old",
			"session-new",
			"session-done",
		]);

		const rows = buildAgentsViewModel({ sessions, now });
		expect(rows.sessions.map((item) => item.id)).toEqual([
			"session-new",
			"session-old",
			"session-done",
		]);
		expect(rows.sessions[2].isCompleted).toBe(true);

		vi.setSystemTime(Date.parse("2026-03-22T12:00:16.000Z"));
		expect(pruneCompletedSessions(sessions, Date.now()).map((item) => item.id)).toEqual([
			"session-old",
			"session-new",
		]);

		vi.useRealTimers();
	});

	it("maps task states to expected status colors", () => {
		expect(getStatusColor("running")).toBe("green");
		expect(getStatusColor("todo")).toBe("yellow");
		expect(getStatusColor("queued")).toBe("yellow");
		expect(getStatusColor("error")).toBe("red");
		expect(getStatusColor("stuck")).toBe("red");
		expect(getStatusColor("rework")).toBe("magenta");
		expect(getStatusColor("paused")).toBe("gray");
	});

	it("clamps keyboard navigation to available rows", () => {
		expect(selectNextIndex(0, -1, 3)).toBe(0);
		expect(selectNextIndex(0, 1, 3)).toBe(1);
		expect(selectNextIndex(2, 1, 3)).toBe(2);
		expect(selectNextIndex(5, 1, 0)).toBe(0);
	});

	it("formats backoff queue countdowns and attempts", () => {
		const now = Date.parse("2026-03-22T12:00:00.000Z");
		const rows = buildAgentsViewModel({
			sessions: [],
			backoffQueue: [
				{
					taskId: "TASK-123",
					attempt: 3,
					nextRetryAt: "2026-03-22T12:00:12.000Z",
				},
			],
			now,
		});

		expect(rows.backoffQueue).toEqual([
			{
				attempt: 3,
				countdown: "12s",
				id: "TASK-123",
			},
		]);
	});

	it("builds OSC 52 clipboard payloads", () => {
		const sequence = buildOsc52Sequence("123e4567-e89b-12d3-a456-426614174000");
		expect(sequence.startsWith("\u001B]52;c;")).toBe(true);
		expect(sequence.endsWith("\u0007")).toBe(true);
	});

	it("builds explicit kill confirmation labels from the selected row", () => {
		expect(buildKillConfirmationLabel({ id: "MT-734-long-session-id" })).toBe(
			"Kill MT-734-l? [y/N]"
		);
		expect(buildKillConfirmationLabel({ id: "MT-734" })).toBe("Kill MT-734? [y/N]");
	});

	it("creates session commands for inline actions", () => {
		const session = {
			id: "123e4567-e89b-12d3-a456-426614174000",
			sessionId: "sess-42",
			pid: 456,
			turn: 7,
		};

		expect(buildSessionCommand("kill", session)).toEqual({
			type: "session:kill",
			payload: {
				id: "123e4567-e89b-12d3-a456-426614174000",
				pid: 456,
				sessionId: "sess-42",
				turn: 7,
			},
		});

		expect(buildSessionCommand("pause", session)).toEqual({
			type: "session:pause",
			payload: {
				id: "123e4567-e89b-12d3-a456-426614174000",
				pid: 456,
				sessionId: "sess-42",
				turn: 7,
			},
		});

		expect(buildSessionCommand("resume", session)).toEqual({
			type: "session:resume",
			payload: {
				id: "123e4567-e89b-12d3-a456-426614174000",
				pid: 456,
				sessionId: "sess-42",
				turn: 7,
			},
		});

		expect(buildSessionCommand("copy", session)).toEqual({
			type: "session:copy",
			payload: {
				id: "123e4567-e89b-12d3-a456-426614174000",
				pid: 456,
				sessionId: "sess-42",
				turn: 7,
			},
		});
	});
	it("prefers kanban stage colors while displaying stage verbatim", () => {
		const rows = buildAgentsViewModel({
			sessions: [
				{
					id: "MT-9000",
					status: "active",
					stage: "rework",
					startedAt: "2026-03-22T12:00:00.000Z",
				},
			],
			now: Date.parse("2026-03-22T12:00:05.000Z"),
		});

		expect(rows.sessions[0].stageText.trim()).toBe("rework");
		expect(rows.sessions[0].statusColor).toBe("magenta");
	});
	it("keeps newest sessions first while using current retry stats shape", () => {
		const now = Date.parse("2026-03-22T12:00:05.000Z");
		const rows = buildAgentsViewModel({
			sessions: [
				{
					id: "MT-1000-older",
					status: "running",
					stage: "queued",
					startedAt: "2026-03-22T12:00:01.000Z",
					tokens: 1000,
					event: "older event",
				},
				{
					id: "MT-1001-newer",
					status: "active",
					stage: "running",
					startedAt: "2026-03-22T12:00:04.000Z",
					tokens: 2500,
					event: "newer event",
				},
			],
			backoffQueue: [
				{
					id: "TASK-999",
					retryAttempt: 2,
					retryAt: "2026-03-22T12:00:09.000Z",
				},
			],
			now,
		});

		expect(rows.sessions.map((row) => row.id)).toEqual(["MT-1001-newer", "MT-1000-older"]);
		expect(rows.sessions[0].stageText.trim()).toBe("running");
		expect(rows.sessions[0].tokensText.trim()).toBe("2,500");
		expect(rows.sessions[0].eventText).toBe("newer event");
		expect(rows.backoffQueue).toEqual([
			{
				attempt: 2,
				countdown: "4s",
				id: "TASK-999",
			},
		]);
	});
});






