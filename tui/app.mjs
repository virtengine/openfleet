import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";
import wsBridge from "./lib/ws-bridge.mjs";
import StatusHeader from "./components/status-header.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import StatusScreen from "./screens/status.mjs";

const SCREENS = {
	status: StatusScreen,
	tasks: TasksScreen,
	agents: AgentsScreen,
};

export default function App({ host, port, connectOnly, initialScreen, refreshMs }) {
	const [screen, setScreen] = useState(initialScreen || "status");
	const [connected, setConnected] = useState(false);
	const [stats, setStats] = useState(null);
	const [sessions, setSessions] = useState([]);
	const [tasks, setTasks] = useState([]);
	const [error, setError] = useState(null);
	const [focusedPanel, setFocusedPanel] = useState("header");

	useEffect(() => {
		const bridge = wsBridge({ host, port });

		bridge.on("connect", () => {
			setConnected(true);
			setError(null);
		});

		bridge.on("disconnect", () => {
			setConnected(false);
		});

		bridge.on("error", (err) => {
			setError(err.message);
		});

		bridge.on("stats", (data) => {
			setStats(data);
		});

		bridge.on("session:start", (session) => {
			setSessions((prev) => [...prev, session]);
		});

		bridge.on("session:update", (session) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === session.id ? session : s))
			);
		});

		bridge.on("session:end", (session) => {
			setSessions((prev) => prev.filter((s) => s.id !== session.id));
		});

		bridge.on("task:update", (task) => {
			setTasks((prev) => {
				const idx = prev.findIndex((t) => t.id === task.id);
				if (idx >= 0) {
					const updated = [...prev];
					updated[idx] = task;
					return updated;
				}
				return [...prev, task];
			});
		});

		bridge.on("task:create", (task) => {
			setTasks((prev) => [...prev, task]);
		});

		bridge.on("task:delete", (taskId) => {
			setTasks((prev) => prev.filter((t) => t.id !== taskId));
		});

		bridge.on("retry:update", (retryData) => {
			setStats((prev) => ({
				...prev,
				retryQueue: retryData,
			}));
		});

		bridge.connect();

		return () => {
			bridge.disconnect();
		};
	}, [host, port]);

	const handleKeyPress = useCallback((key) => {
		if (key === "q") {
			process.exit(0);
		}
		if (key === "1") {
			setScreen("status");
		}
		if (key === "2") {
			setScreen("tasks");
		}
		if (key === "3") {
			setScreen("agents");
		}
		if (key === "r") {
			if (wsBridge._instance?._ws) {
				wsBridge._instance._ws.send(JSON.stringify({ type: "refresh" }));
			}
		}
	}, []);

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

	const ScreenComponent = SCREENS[screen] || StatusScreen;

	// Get the actual instance for passing to children
	const wsBridgeInstance = typeof wsBridge === "function" ? wsBridge({ host, port }) : wsBridge;

	return (
		<Box flexDirection="column" minHeight={0}>
			<StatusHeader
				stats={stats}
				connected={connected}
				screen={screen}
				focused={focusedPanel === "header"}
				onScreenChange={setScreen}
			/>
			<Box flexDirection="column" flexGrow={1}>
				{error && (
					<Box paddingX={1} paddingY={0} backgroundColor="red">
						<Text bold>Error: {error}</Text>
					</Box>
				)}
				<ScreenComponent
					stats={stats}
					sessions={sessions}
					tasks={tasks}
					wsBridge={wsBridgeInstance}
					refreshMs={refreshMs}
				/>
			</Box>
			<Box paddingX={1} borderStyle="single" borderTop>
				<Text dimColor>
					[1] Status [2] Tasks [3] Agents [r] Refresh [q] Quit
				</Text>
			</Box>
		</Box>
	);
}
