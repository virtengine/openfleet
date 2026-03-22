import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("ink", async () => {
	const React = await import("react");
	return {
		Box: ({ children }) => React.createElement("box", null, children),
		Text: ({ children, ...props }) => React.createElement("text", props, children),
		useInput: (handler) => {
			globalThis.__inkInputHandler = handler;
		},
		useStdout: () => ({
			stdout: {
				columns: 120,
				write: vi.fn(),
			},
		}),
	};
});

vi.mock("ink-table", async () => {
	const React = await import("react");
	return {
		default: ({ data }) => React.createElement("table", null, data.map((row, index) => React.createElement("text", { key: index }, Object.values(row).join(" ")))),
	};
});

import AgentsScreen from "../tui/screens/agents.mjs";

function session(overrides = {}) {
	return {
		id: "123e4567-e89b-12d3-a456-426614174000",
		sessionId: "session-123",
		status: "running",
		stage: "implementing",
		startedAt: "2026-03-22T12:00:00.000Z",
		pid: 321,
		turn: 2,
		tokens: 1400,
		event: "Applying patch to agents screen",
		executor: "codex",
		...overrides,
	};
}

function texts(node) {
	return node.root.findAll((item) => item.type === "text").map((item) => ({ children: item.children.join(""), props: item.props }));
}

describe("tui agents screen rendering and inputs", () => {
	afterEach(() => {
		delete globalThis.__inkInputHandler;
		vi.useRealTimers();
	});

	it("renders action bar and live backoff queue", () => {
		const tree = TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session()], stats: { retryQueue: [{ taskId: "MT-734", attempt: 3, nextRetryAt: "2026-03-22T12:00:05.000Z" }] }, refreshMs: 1000 }));
		const output = texts(tree).map((item) => item.children).join("\n");
		expect(output).toContain("Backoff queue");
		expect(output).toContain("MT-734");
		expect(output).toContain("attempt 3");
		expect(output).toContain("[K]ill session | [P]ause | [R]esume | [L]ogs | [D]iff | [C]opy ID | [Enter] Detail — [B] Backoff");
	});

	it("requires kill confirmation before sending kill command", () => {
		const wsBridge = { send: vi.fn(), on: vi.fn(() => () => {}) };
		const tree = TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session({ id: "MT-734" })], wsBridge, refreshMs: 1000 }));
		act(() => globalThis.__inkInputHandler("k", {}));
		expect(wsBridge.send).not.toHaveBeenCalled();
		expect(texts(tree).map((item) => item.children).join("\n")).toContain("Kill MT-734? [y/N]");
		act(() => globalThis.__inkInputHandler("y", {}));
		expect(wsBridge.send).toHaveBeenCalledWith("session:kill", { id: "MT-734", pid: 321, sessionId: "session-123", turn: 2 });
	});

	it("opens logs and diff using the selected session", () => {
		const wsBridge = { send: vi.fn(), on: vi.fn(() => () => {}) };
		const onOpenLogs = vi.fn();
		const onOpenDiff = vi.fn();
		TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session()], wsBridge, onOpenLogs, onOpenDiff, refreshMs: 1000 }));
		act(() => {
			globalThis.__inkInputHandler("l", {});
			globalThis.__inkInputHandler("d", {});
		});
		expect(onOpenLogs).toHaveBeenCalledWith("session-123");
		expect(onOpenDiff).toHaveBeenCalledWith(expect.objectContaining({ id: "123e4567-e89b-12d3-a456-426614174000" }));
		expect(wsBridge.send).toHaveBeenCalledWith("session:logs", expect.objectContaining({ sessionId: "session-123" }));
		expect(wsBridge.send).toHaveBeenCalledWith("session:diff", expect.objectContaining({ sessionId: "session-123" }));
	});

	it("updates sessions from websocket events and keeps newest first", () => {
		let sessionsHandler;
		const wsBridge = { send: vi.fn(), on: vi.fn((event, handler) => { if (event === "sessions:update") sessionsHandler = handler; return () => {}; }) };
		const tree = TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session({ id: "older-1", startedAt: "2026-03-22T12:00:00.000Z" })], wsBridge, refreshMs: 1000 }));
		act(() => sessionsHandler?.([session({ id: "older-1", startedAt: "2026-03-22T12:00:00.000Z" }), session({ id: "newer-2", startedAt: "2026-03-22T12:00:05.000Z", event: "Newest event" })]));
		const textOutput = texts(tree).map((item) => item.children).join("\n");
		expect(textOutput.indexOf("newer-2")).toBeGreaterThan(-1);
		expect(textOutput.indexOf("older-1")).toBeGreaterThan(-1);
		expect(textOutput.indexOf("newer-2")).toBeLessThan(textOutput.indexOf("older-1"));
	});

	it("toggles backoff queue collapse with B", () => {
		const tree = TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session()], stats: { retryQueue: [{ taskId: "MT-900", attempt: 2, nextRetryAt: "2026-03-22T12:00:05.000Z" }] }, refreshMs: 1000 }));
		act(() => globalThis.__inkInputHandler("b", {}));
		expect(texts(tree).map((item) => item.children).join("\n")).toContain("Press [B] to expand.");
	});

	it("opens detail on Enter using the selected session", () => {
		const wsBridge = { send: vi.fn(), on: vi.fn(() => () => {}) };
		const onOpenDetail = vi.fn();
		TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session({ id: "MT-800" })], wsBridge, onOpenDetail, refreshMs: 1000 }));
		act(() => globalThis.__inkInputHandler("", { return: true }));
		expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "MT-800" }));
		expect(wsBridge.send).toHaveBeenCalledWith("session:detail", expect.objectContaining({ id: "MT-800" }));
	});

	it("refreshes backoff countdowns on retry:update events", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
		let retryHandler;
		const wsBridge = { send: vi.fn(), on: vi.fn((event, handler) => { if (event === "retry:update") retryHandler = handler; return () => {}; }) };
		const tree = TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session()], stats: { retryQueue: [{ taskId: "MT-734", attempt: 3, nextRetryAt: "2026-03-22T12:00:05.000Z" }] }, wsBridge, refreshMs: 1000 }));
		expect(texts(tree).map((item) => item.children).join("\n")).toContain("retry in 5s");
		act(() => {
			vi.setSystemTime(new Date("2026-03-22T12:00:03.000Z"));
			retryHandler?.({});
		});
		expect(texts(tree).map((item) => item.children).join("\n")).toContain("retry in 2s");
	});

	it("moves selection with arrow keys and opens detail for the selected row", () => {
		const wsBridge = { send: vi.fn(), on: vi.fn(() => () => {}) };
		const onOpenDetail = vi.fn();
		TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session({ id: "older-1", sessionId: "session-older", startedAt: "2026-03-22T12:00:00.000Z" }), session({ id: "newer-2", sessionId: "session-newer", startedAt: "2026-03-22T12:00:05.000Z" })], wsBridge, onOpenDetail, refreshMs: 1000 }));
		act(() => {
			globalThis.__inkInputHandler("", { downArrow: true });
			globalThis.__inkInputHandler("\r", { return: true });
		});
		expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "older-1", sessionId: "session-older" }));
		expect(wsBridge.send).toHaveBeenCalledWith("session:detail", expect.objectContaining({ sessionId: "session-older" }));
	});

	it("copies the selected session id via OSC 52", () => {
		const write = vi.fn();
		const originalStdoutWrite = process.stdout.write;
		process.stdout.write = write;
		try {
			TestRenderer.create(React.createElement(AgentsScreen, { sessions: [session({ id: "123e4567-e89b-12d3-a456-426614174000" })], refreshMs: 1000 }));
			act(() => globalThis.__inkInputHandler("c", {}));
			expect(write).toHaveBeenCalled();
			expect(String(write.mock.calls[0][0])).toContain("]52;c;");
		} finally {
			process.stdout.write = originalStdoutWrite;
		}
	});
});