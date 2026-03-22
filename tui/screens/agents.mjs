import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import Table from "ink-table";
import {
	buildAgentsViewModel,
	buildKillConfirmationLabel,
	buildOsc52Sequence,
	buildSessionCommand,
	selectNextIndex,
} from "./agents-helpers.mjs";

function truncate(value, width) {
	const text = String(value ?? "-");
	if (width <= 0) return "";
	if (text.length <= width) return text.padEnd(width, " ");
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function writeOsc52(stdout, value) {
	if (!stdout || !value) return;
	stdout.write(buildOsc52Sequence(value));
}

function SessionTable({ sessions, selectedIndex, eventWidth }) {
	if (sessions.length <= 0) {
		return React.createElement(Text, { dimColor: true }, "No live sessions.");
	}

	const rows = sessions.map((session, index) => ({
		STATUS: `${index === selectedIndex ? ">" : " "}${session.statusDot}`,
		ID: session.idShort,
		STAGE: String(session.stageText).trimEnd(),
		PID: String(session.pidText).trimEnd(),
		"AGE/TURN": String(session.ageTurn).trimEnd(),
		TOKENS: String(session.tokensText).trimEnd(),
		SESSION: String(session.sessionText).trimEnd(),
		EVENT: truncate(session.eventText, eventWidth).trimEnd(),
	}));

	return React.createElement(Table, {
		data: rows,
		columns: [
			{
				key: "STATUS",
				render: (value, rowIndex) =>
					React.createElement(Text, {
						color: sessions[rowIndex]?.statusColor,
						dimColor: sessions[rowIndex]?.isCompleted,
						inverse: rowIndex === selectedIndex,
					}, value),
			},
			{ key: "ID" },
			{ key: "STAGE" },
			{ key: "PID" },
			{ key: "AGE/TURN" },
			{ key: "TOKENS" },
			{ key: "SESSION" },
			{ key: "EVENT" },
		],
	});
}

function BackoffRow({ entry }) {
	return React.createElement(
		Box,
		null,
		React.createElement(Text, { dimColor: true }, "• "),
		React.createElement(Text, null, entry.id),
		React.createElement(Text, { dimColor: true }, `  attempt ${entry.attempt}  retry in ${entry.countdown}`),
	);
}

export {
	buildAgentsViewModel,
	buildKillConfirmationLabel,
	buildOsc52Sequence,
	buildSessionCommand,
	selectNextIndex,
} from "./agents-helpers.mjs";

export default function AgentsScreen({ sessions = [], stats = {}, wsBridge, onOpenLogs, onOpenDiff, onOpenDetail, refreshMs = 1000 }) {
	const { stdout } = useStdout();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [confirmKill, setConfirmKill] = useState(false);
	const [backoffCollapsed, setBackoffCollapsed] = useState(false);
	const [tick, setTick] = useState(Date.now());
	const [liveSessions, setLiveSessions] = useState(() => sessions);
	const [backoffQueue, setBackoffQueue] = useState(() => stats?.retryQueue ?? stats?.backoffQueue ?? []);

	useEffect(() => setLiveSessions(sessions), [sessions]);
	useEffect(() => setBackoffQueue(stats?.retryQueue ?? stats?.backoffQueue ?? []), [stats]);

	useEffect(() => {
		if (!wsBridge?.on) return undefined;
		const unsubscribeSessions = wsBridge.on("sessions:update", (payload) => {
			if (Array.isArray(payload)) setLiveSessions(payload);
			else if (Array.isArray(payload?.sessions)) setLiveSessions(payload.sessions);
			setTick(Date.now());
		});
		const unsubscribeRetry = wsBridge.on("retry:update", (payload) => {
			if (Array.isArray(payload)) setBackoffQueue(payload);
			else if (Array.isArray(payload?.backoffQueue)) setBackoffQueue(payload.backoffQueue);
			else if (Array.isArray(payload?.retryQueue)) setBackoffQueue(payload.retryQueue);
			setTick(Date.now());
		});
		return () => {
			unsubscribeSessions?.();
			unsubscribeRetry?.();
		};
	}, [wsBridge]);

	useEffect(() => {
		const timer = setInterval(() => setTick(Date.now()), refreshMs);
		return () => clearInterval(timer);
	}, [refreshMs]);

	const viewModel = useMemo(() => buildAgentsViewModel({ sessions: liveSessions, backoffQueue, now: tick }), [liveSessions, backoffQueue, tick]);
	useEffect(() => setSelectedIndex((current) => selectNextIndex(current, 0, viewModel.sessions.length)), [viewModel.sessions.length]);

	const currentSession = viewModel.sessions[selectedIndex] ?? null;
	const eventWidth = Math.max(24, (stdout?.columns || 120) - 90);
	const sendAction = (type, payload) => {
		if (typeof wsBridge?.send === "function") wsBridge.send(type, payload);
	};

	useInput((input, key) => {
		const lower = String(input || "").toLowerCase();
		if (confirmKill) {
			if (lower === "y" && currentSession) {
				const command = buildSessionCommand("kill", currentSession);
				sendAction(command.type, command.payload);
				setConfirmKill(false);
				return;
			}
			if (key.escape || lower === "n" || key.return) {
				setConfirmKill(false);
				return;
			}
		}
		if (key.upArrow) return setSelectedIndex((current) => selectNextIndex(current, -1, viewModel.sessions.length));
		if (key.downArrow) return setSelectedIndex((current) => selectNextIndex(current, 1, viewModel.sessions.length));
		if (lower === "b") return setBackoffCollapsed((current) => !current);
		if (!currentSession) return;
		if (lower === "k") return setConfirmKill(true);
		if (lower === "p") {
			const command = buildSessionCommand("pause", currentSession);
			return sendAction(command.type, command.payload);
		}
		if (lower === "r") {
			const command = buildSessionCommand("resume", currentSession);
			return sendAction(command.type, command.payload);
		}
		if (lower === "l") {
			onOpenLogs?.(currentSession.sessionId ?? currentSession.id);
			const command = buildSessionCommand("logs", currentSession);
			return sendAction(command.type, command.payload);
		}
		if (lower === "d") {
			onOpenDiff?.(currentSession);
			const command = buildSessionCommand("diff", currentSession);
			return sendAction(command.type, command.payload);
		}
		if (lower === "c") return writeOsc52(stdout ?? process.stdout, currentSession.id ?? currentSession.sessionId);
		if (key.return) {
			onOpenDetail?.(currentSession);
			const command = buildSessionCommand("detail", currentSession);
			return sendAction(command.type, command.payload);
		}
	});

	return React.createElement(
		Box,
		{ flexDirection: "column" },
		React.createElement(Text, { bold: true }, "Agents"),
		React.createElement(SessionTable, { sessions: viewModel.sessions, selectedIndex, eventWidth }),
		React.createElement(
			Box,
			{ flexDirection: "column", marginTop: 1 },
			React.createElement(Text, { bold: true }, `Backoff queue${backoffCollapsed ? " (collapsed)" : ""}`),
			...(backoffCollapsed
				? [React.createElement(Text, { key: "backoff-collapsed", dimColor: true }, "Press [B] to expand.")]
				: viewModel.backoffQueue.length > 0
					? viewModel.backoffQueue.map((entry, index) => React.createElement(BackoffRow, { key: `${entry.id}-${entry.attempt}-${index}`, entry }))
					: [React.createElement(Text, { key: "backoff-empty", dimColor: true }, "No queued retries.")]),
		),
		React.createElement(
			Box,
			{ marginTop: 1 },
			confirmKill
				? React.createElement(Text, { color: "yellow" }, buildKillConfirmationLabel(currentSession))
				: React.createElement(Text, { dimColor: true }, "[K]ill session | [P]ause | [R]esume | [L]ogs | [D]iff | [C]opy ID | [Enter] Detail — [B] Backoff"),
		),
	);
}