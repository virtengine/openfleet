import React from "react";
import { Box, Text } from "ink";

function Spinner({ frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], interval = 80 }) {
	const [frame, setFrame] = React.useState(0);

	React.useEffect(() => {
		const id = setInterval(() => {
			setFrame((prev) => (prev + 1) % frames.length);
		}, interval);
		return () => clearInterval(id);
	}, [frames.length, interval]);

	return <Text>{frames[frame]}</Text>;
}

function StatCard({ label, value, unit, color, subtext }) {
	return (
		<Box flexDirection="column" padding={1} borderStyle="single" marginX={1}>
			<Text dimColor>{label}</Text>
			<Text bold font="bold" color={color}>
				{value}
				{unit && <Text dimColor> {unit}</Text>}
			</Text>
			{subtext && <Text dimColor>{subtext}</Text>}
		</Box>
	);
}

function RetryQueueSection({ retryQueue }) {
	if (!retryQueue || !retryQueue.items || retryQueue.items.length === 0) {
		return (
			<Box flexDirection="column" padding={1} borderStyle="single">
				<Text bold>Retry Queue</Text>
				<Text dimColor>No items in retry queue</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1} borderStyle="single">
			<Text bold>
				Retry Queue <Text color="yellow">({retryQueue.items.length})</Text>
			</Text>
			{retryQueue.items.slice(0, 5).map((item, idx) => (
				<Box key={item.taskId || idx} paddingY={0}>
					<Text dimColor>#{idx + 1}</Text>
					<Text> </Text>
					<Text>{item.taskId?.slice(0, 12) || "?"}</Text>
					<Text> - </Text>
					<Text color="yellow">{item.retryCount || 0} retries</Text>
					<Text> - </Text>
					<Text dimColor>{item.lastError?.slice(0, 40) || "unknown error"}</Text>
				</Box>
			))}
			{retryQueue.items.length > 5 && (
				<Text dimColor>... and {retryQueue.items.length - 5} more</Text>
			)}
		</Box>
	);
}

function WorkflowsSection({ workflows }) {
	if (!workflows || workflows.length === 0) {
		return (
			<Box flexDirection="column" padding={1} borderStyle="single">
				<Text bold>Active Workflows</Text>
				<Text dimColor>No active workflows</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1} borderStyle="single">
			<Text bold>Active Workflows</Text>
			{workflows.slice(0, 5).map((wf, idx) => (
				<Box key={wf.id || idx} paddingY={0}>
					<Text color="cyan">{wf.id?.slice(0, 20) || "?"}</Text>
					<Text> - </Text>
					<Text>{wf.status || "running"}</Text>
					{wf.progress !== undefined && (
						<>
							<Text> </Text>
							<Text dimColor>{wf.progress}%</Text>
						</>
					)}
				</Box>
			))}
		</Box>
	);
}

export default function StatusScreen({ stats, sessions, tasks }) {
	const defaultStats = {
		uptimeMs: 0,
		runtimeMs: 0,
		totalCostUsd: 0,
		totalSessions: 0,
		activeSessions: 0,
		completedSessions: 0,
		failedSessions: 0,
		totalTasks: 0,
		activeTasks: 0,
		completedTasks: 0,
		failedTasks: 0,
		queuedTasks: 0,
		retryQueue: { count: 0, items: [] },
		workflows: { active: [], total: 0 },
		agents: { online: 0, total: 0 },
		memory: { used: 0, total: 0 },
		cpu: { usage: 0 },
	};

	const s = { ...defaultStats, ...stats };

	const activeSessions = (sessions || []).filter((se) => se.status === "active");
	const runningWorkflows = (s.workflows?.active || []).length;

	return (
		<Box flexDirection="column" flexGrow={1} paddingY={1}>
			<Box flexDirection="row" justifyContent="space-around">
				<StatCard
					label="Sessions"
					value={s.activeSessions}
					subtext={`${s.totalSessions} total, ${s.completedSessions} done, ${s.failedSessions} failed`}
					color="green"
				/>
				<StatCard
					label="Tasks"
					value={s.activeTasks}
					subtext={`${s.totalTasks} total, ${s.completedTasks} done, ${s.failedTasks} failed`}
					color="cyan"
				/>
				<StatCard
					label="Runtime"
					value={Math.round(s.runtimeMs / 60000)}
					unit="min"
					subtext={`Uptime: ${Math.round(s.uptimeMs / 3600000)}h`}
					color="blue"
				/>
				<StatCard
					label="Cost"
					value={`$${s.totalCostUsd?.toFixed(2) || "0.00"}`}
					color="yellow"
				/>
			</Box>

			<Box flexDirection="row" marginTop={1}>
				<Box flexGrow={1} flexDirection="column">
					<RetryQueueSection retryQueue={s.retryQueue} />
				</Box>
				<Box flexGrow={1} flexDirection="column">
					<WorkflowsSection workflows={s.workflows?.active || []} />
				</Box>
			</Box>

			<Box flexDirection="column" marginTop={1} padding={1} borderStyle="single">
				<Text bold>System Resources</Text>
				<Box flexDirection="row">
					<Box marginRight={4}>
						<Text dimColor>Memory: </Text>
						<Text>
							{Math.round((s.memory?.used || 0) / 1024 / 1024)} MB
						</Text>
						<Text dimColor> / </Text>
						<Text>
							{Math.round((s.memory?.total || 0) / 1024 / 1024)} MB
						</Text>
					</Box>
					<Box>
						<Text dimColor>CPU: </Text>
						<Text>{s.cpu?.usage?.toFixed(1) || "0.0"}%</Text>
					</Box>
				</Box>
			</Box>

			{activeSessions.length > 0 && (
				<Box flexDirection="column" marginTop={1} padding={1} borderStyle="single">
					<Text bold>Active Sessions ({activeSessions.length})</Text>
					{activeSessions.slice(0, 3).map((session) => (
						<Box key={session.id} paddingY={0}>
							<SpinningIndicator />
							<Text> </Text>
							<Text color="green">{session.executor}</Text>
							<Text> - </Text>
							<Text>{session.taskTitle || session.taskId?.slice(0, 12) || "?"}</Text>
						</Box>
					))}
				</Box>
			)}
		</Box>
	);
}

function SpinningIndicator() {
	return <Spinner interval={100} />;
}
