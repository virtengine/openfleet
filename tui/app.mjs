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

		const upsertSession = (session) => {
			setSessions((prev) => {
				const sessionId = session?.id ?? session?.sessionId;
				const index = prev.findIndex((item) => (item?.id ?? item?.sessionId) === sessionId);
				if (index >= 0) {
					const next = [...prev];
					next[index] = { ...next[index], ...session };
					return next;
				}
				return [...prev, session];
			});
		};

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
			upsertSession(session);
		});

		bridge.on("session:update", (session) => {
			upsertSession(session);
		});

		bridge.on("sessions:update", (payload) => {
			if (Array.isArray(payload)) {
				setSessions(payload);
				return;
			}
			if (Array.isArray(payload?.sessions)) {
				setSessions(payload.sessions);
			}
		});

		bridge.on("session:end", (session) => {
			upsertSession({ ...session, status: session?.status ?? "completed", endedAt: session?.endedAt ?? new Date().toISOString() });
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
				...(prev ?? {}),
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
			if (screen === "agents" && wsBridge._instance?.send) {
				wsBridge._instance.send("sessions:refresh");
				return;
			}
			if (wsBridge._instance?.ws) {
				wsBridge._instance.send("refresh");
			}
		}
	}, [screen]);

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
					onOpenLogs={(sessionId) => {
					wsBridgeInstance?.send?.("screen:logs", { filter: sessionId, sessionId });
				}}
					onOpenDiff={(session) => {
					wsBridgeInstance?.send?.("screen:diff", {
						sessionId: session?.sessionId ?? session?.id,
						id: session?.id ?? session?.sessionId,
					});
				}}
					onOpenDetail={(session) => {
					wsBridgeInstance?.send?.("screen:detail", {
						sessionId: session?.sessionId ?? session?.id,
						id: session?.id ?? session?.sessionId,
					});
				}}
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


