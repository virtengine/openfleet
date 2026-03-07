import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";

const SESSION_STATUS_COLORS = {
	active: "green",
	idle: "cyan",
	completed: "blue",
	failed: "red",
	pending: "yellow",
};

const EXECUTOR_COLORS = {
	codex: "green",
	copilot: "blue",
	claude: "yellow",
	opencode: "magenta",
	gemini: "red",
};

function formatDuration(startedAt, endedAt) {
	if (!startedAt) return "N/A";
	const start = new Date(startedAt).getTime();
	const end = endedAt ? new Date(endedAt).getTime() : Date.now();
	const diff = end - start;

	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function SessionRow({ session, selected, onSelect }) {
	const statusColor = SESSION_STATUS_COLORS[session.status] || "white";
	const executorColor = EXECUTOR_COLORS[session.executor] || "white";

	return (
		<Box
			paddingX={1}
			paddingY={0}
			borderStyle={selected ? "bold" : "single"}
			borderDim={!selected}
			onClick={onSelect}
		>
			<Box width={10}>
				<Text dimColor>{session.id?.slice(0, 8) || "?"}</Text>
			</Box>
			<Box width={12}>
				<Text color={executorColor} bold>
					{session.executor || "unknown"}
				</Text>
			</Box>
			<Box width={10}>
				<Text color={statusColor}>{session.status || "pending"}</Text>
			</Box>
			<Box width={12}>
				<Text>{session.taskId?.slice(0, 10) || "-"}</Text>
			</Box>
			<Box width={12}>
				<Text>{formatDuration(session.startedAt, session.endedAt)}</Text>
			</Box>
			<Box width={15}>
				<Text dimColor>
					{session.model || "-"}
				</Text>
			</Box>
			<Box flexGrow={1}>
				<Text numberOfLines={1}>
					{session.taskTitle || session.prompt?.slice(0, 50) || "-"}
				</Text>
			</Box>
		</Box>
	);
}

function SessionDetail({ session, onClose, onAction }) {
	if (!session) return null;

	return (
		<Box flexDirection="column" padding={1} borderStyle="bold" borderColor="cyan">
			<Box justifyContent="space-between">
				<Text bold>Session Details</Text>
				<Text dimColor onClick={onClose}>
					[Esc] Close
				</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Box>
					<Text dimColor>ID: </Text>
					<Text>{session.id}</Text>
				</Box>
				<Box>
					<Text dimColor>Executor: </Text>
					<Text color={EXECUTOR_COLORS[session.executor]}>
						{session.executor}
					</Text>
				</Box>
				<Box>
					<Text dimColor>Status: </Text>
					<Text color={SESSION_STATUS_COLORS[session.status]}>
						{session.status}
					</Text>
				</Box>
				<Box>
					<Text dimColor>Task: </Text>
					<Text>{session.taskTitle || session.taskId}</Text>
				</Box>
				<Box>
					<Text dimColor>Model: </Text>
					<Text>{session.model || "-"}</Text>
				</Box>
				<Box>
					<Text dimColor>Started: </Text>
					<Text>{session.startedAt ? new Date(session.startedAt).toLocaleString() : "N/A"}</Text>
				</Box>
				<Box>
					<Text dimColor>Duration: </Text>
					<Text>{formatDuration(session.startedAt, session.endedAt)}</Text>
				</Box>
				{session.error && (
					<Box flexDirection="column" marginTop={1}>
						<Text red bold>
							Error:
						</Text>
						<Text red>{session.error}</Text>
					</Box>
				)}
			</Box>
			<Box marginTop={1}>
				<Text green onClick={() => onAction("continue", session)}>
					[Enter] Continue Session
				</Text>
				<Text> </Text>
				<Text red onClick={() => onAction("terminate", session)}>
					[t] Terminate
				</Text>
			</Box>
		</Box>
	);
}

export default function AgentsScreen({ sessions, wsBridge, refreshMs }) {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [showDetail, setShowDetail] = useState(false);
	const [sortBy, setSortBy] = useState("startedAt");
	const [filterExecutor, setFilterExecutor] = useState("");

	const sortedSessions = [...(sessions || [])]
		.filter((s) => !filterExecutor || s.executor === filterExecutor)
		.sort((a, b) => {
			if (sortBy === "startedAt") {
				return new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime();
			}
			if (sortBy === "status") {
				return (a.status || "").localeCompare(b.status || "");
			}
			if (sortBy === "executor") {
				return (a.executor || "").localeCompare(b.executor || "");
			}
			return 0;
		});

	const currentSession = sortedSessions[selectedIndex];
	const executors = [...new Set((sessions || []).map((s) => s.executor).filter(Boolean))];

	const handleKeyPress = useCallback((key) => {
		if (showDetail) {
			if (key === "Escape") {
				setShowDetail(false);
			}
			if (key === "Enter" && currentSession) {
				wsBridge.send("session:continue", { sessionId: currentSession.id });
			}
			if (key === "t" && currentSession) {
				wsBridge.send("session:terminate", { sessionId: currentSession.id });
			}
			return;
		}

		if (key === "k" || key === "arrowUp") {
			setSelectedIndex((prev) => Math.max(0, prev - 1));
		}
		if (key === "j" || key === "arrowDown") {
			setSelectedIndex((prev) => Math.min(sortedSessions.length - 1, prev + 1));
		}
		if (key === "Enter") {
			setShowDetail(true);
		}
		if (key === "s") {
			setSortBy((prev) => (prev === "startedAt" ? "status" : prev === "status" ? "executor" : "startedAt"));
		}
		if (key === "f") {
			setFilterExecutor((prev) => {
				const execs = executors;
				const idx = execs.indexOf(prev);
				return execs[(idx + 1) % execs.length] || "";
			});
		}
	}, [sortedSessions.length, showDetail, currentSession]);

	useEffect(() => {
		process.stdin.setRawMode(true);
		const handle = (chunk) => {
			const key = chunk.toString();
			handleKeyPress(key);
		};
		process.stdin.on("data", handle);
		return () => {
			process.stdin.removeListener("data", handle);
			process.stdin.setRawMode(false);
		};
	}, [handleKeyPress]);

	const handleAction = (action, session) => {
		wsBridge.send(`session:${action}`, { sessionId: session.id });
		setShowDetail(false);
	};

	return (
		<Box flexDirection="column" flexGrow={1} paddingY={1}>
			<Box paddingX={1} borderStyle="single" borderBottom>
				<Box width={10}>
					<Text bold dimColor>
						ID
					</Text>
				</Box>
				<Box width={12}>
					<Text bold dimColor>
						Executor
					</Text>
				</Box>
				<Box width={10}>
					<Text bold dimColor>
						Status
					</Text>
				</Box>
				<Box width={12}>
					<Text bold dimColor>
						Task ID
					</Text>
				</Box>
				<Box width={12}>
					<Text bold dimColor>
						Duration
					</Text>
				</Box>
				<Box width={15}>
					<Text bold dimColor>
						Model
					</Text>
				</Box>
				<Box flexGrow={1}>
					<Text bold dimColor>
						Title / Prompt
					</Text>
				</Box>
			</Box>

			<Box flexDirection="column" flexGrow={1}>
				{sortedSessions.map((session, idx) => (
					<SessionRow
						key={session.id}
						session={session}
						selected={idx === selectedIndex}
						onSelect={() => setSelectedIndex(idx)}
					/>
				))}
				{sortedSessions.length === 0 && (
					<Box padding={1}>
						<Text dimColor>No active sessions</Text>
					</Box>
				)}
			</Box>

			{showDetail && currentSession && (
				<SessionDetail
					session={currentSession}
					onClose={() => setShowDetail(false)}
					onAction={handleAction}
				/>
			)}

			{!showDetail && (
				<Box paddingX={1} borderStyle="single" borderTop>
					<Text dimColor>
						 [↑↓] Navigate [Enter] Details [s] Sort: {sortBy} [f] Filter: {filterExecutor || "all"}
					</Text>
				</Box>
			)}
		</Box>
	);
}
