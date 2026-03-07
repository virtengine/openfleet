import React from "react";
import { Box, Text } from "ink";

const STATUS_COLORS = {
	connected: "green",
	disconnected: "red",
	error: "red",
	warning: "yellow",
	idle: "cyan",
	active: "green",
};

function formatUptime(ms) {
	if (!ms || ms < 0) return "N/A";
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function formatRuntime(ms) {
	if (!ms || ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function formatCost(usd) {
	if (!usd || usd < 0) return "$0.00";
	return `$${usd.toFixed(2)}`;
}

export default function StatusHeader({ stats, connected, screen, focused, onScreenChange }) {
	const defaultStats = {
		uptimeMs: 0,
		totalSessions: 0,
		activeSessions: 0,
		totalTasks: 0,
		activeTasks: 0,
		completedTasks: 0,
		failedTasks: 0,
		queuedTasks: 0,
		runtimeMs: 0,
		totalCostUsd: 0,
		retryQueue: { count: 0, items: [] },
		workflows: { active: 0, total: 0 },
		agents: { online: 0, total: 0 },
	};

	const s = { ...defaultStats, ...stats };

	const navItems = [
		{ key: "status", label: "Status", num: "1" },
		{ key: "tasks", label: "Tasks", num: "2" },
		{ key: "agents", label: "Agents", num: "3" },
	];

	return (
		<Box flexDirection="column" borderStyle="bold" borderBottom>
			<Box flexDirection="row" justifyContent="space-between" paddingX={1}>
				<Box>
					<Text bold> Bosun TUI </Text>
					<Text dimColor> | </Text>
					<Text
						color={connected ? STATUS_COLORS.connected : STATUS_COLORS.disconnected}
						bold={!connected}
					>
						{connected ? "Connected" : "Disconnected"}
					</Text>
				</Box>
				<Box>
					<Text dimColor>Uptime: </Text>
					<Text>{formatUptime(s.uptimeMs)}</Text>
					<Text dimColor> | Runtime: </Text>
					<Text>{formatRuntime(s.runtimeMs)}</Text>
					<Text dimColor> | Cost: </Text>
					<Text>{formatCost(s.totalCostUsd)}</Text>
				</Box>
			</Box>

			<Box flexDirection="row" paddingX={1} paddingY={0}>
				<Box marginRight={2}>
					<Text dimColor>Sessions: </Text>
					<Text color={s.activeSessions > 0 ? STATUS_COLORS.active : undefined}>
						{s.activeSessions}
					</Text>
					<Text dimColor>/{s.totalSessions}</Text>
				</Box>
				<Box marginRight={2}>
					<Text dimColor>Tasks: </Text>
					<Text color={s.activeTasks > 0 ? STATUS_COLORS.active : undefined}>
						{s.activeTasks}
					</Text>
					<Text dimColor>/{s.totalTasks} </Text>
					<Text dimColor>(done:{s.completedTasks} fail:{s.failedTasks})</Text>
				</Box>
				<Box marginRight={2}>
					<Text dimColor>Retry: </Text>
					<Text color={s.retryQueue?.count > 0 ? STATUS_COLORS.warning : undefined}>
						{s.retryQueue?.count || 0}
					</Text>
				</Box>
				<Box marginRight={2}>
					<Text dimColor>Workflows: </Text>
					<Text color={s.workflows?.active > 0 ? STATUS_COLORS.active : undefined}>
						{s.workflows?.active || 0}
					</Text>
					<Text dimColor>/{s.workflows?.total || 0}</Text>
				</Box>
				<Box>
					<Text dimColor>Agents: </Text>
					<Text color={s.agents?.online > 0 ? STATUS_COLORS.active : undefined}>
						{s.agents?.online || 0}
					</Text>
					<Text dimColor>/{s.agents?.total || 0}</Text>
				</Box>
			</Box>

			<Box flexDirection="row" paddingX={1} paddingY={0} borderStyle="single" borderTop>
				{navItems.map((item) => (
					<Box key={item.key} marginRight={3}>
						<Text
							bold={screen === item.key}
							inverse={screen === item.key}
							color={screen === item.key ? undefined : "cyan"}
						>
							[{item.num}] {item.label}
						</Text>
					</Box>
				))}
			</Box>
		</Box>
	);
}
