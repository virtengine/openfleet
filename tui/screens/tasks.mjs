import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";
import { TextInput } from "ink-text-input";

const COLUMNS = ["todo", "inprogress", "inreview", "blocked", "done"];
const COLUMN_LABELS = {
	todo: "To Do",
	inprogress: "In Progress",
	inreview: "In Review",
	blocked: "Blocked",
	done: "Done",
};

const STATUS_COLORS = {
	todo: "white",
	inprogress: "cyan",
	inreview: "yellow",
	blocked: "red",
	done: "green",
};

function TaskCard({ task, selected, onSelect }) {
	const statusColor = STATUS_COLORS[task.status] || "white";

	return (
		<Box
			flexDirection="column"
			paddingX={1}
			paddingY={0}
			borderStyle={selected ? "bold" : "single"}
			borderDim={!selected}
			onClick={onSelect}
		>
			<Box>
				<Text bold dimColor>
					#{task.id?.slice(0, 8) || "?"}
				</Text>
				<Text> </Text>
				<Text color={statusColor}>{task.status}</Text>
			</Box>
			<Text numberOfLines={2}>{task.title || "Untitled"}</Text>
			{task.assignee && (
				<Text dimColor>@{task.assignee}</Text>
			)}
			{task.priority && (
				<Text dimColor>Priority: {task.priority}</Text>
			)}
		</Box>
	);
}

function CreateTaskModal({ onSubmit, onCancel }) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [status, setStatus] = useState("todo");

	return (
		<Box flexDirection="column" padding={1} borderStyle="bold" borderColor="cyan">
			<Text bold>Create New Task</Text>
			<Box marginTop={1}>
				<Text>Title: </Text>
				<TextInput value={title} onChange={setTitle} placeholder="Task title" />
			</Box>
			<Box marginTop={1}>
				<Text>Status: </Text>
				<Box>
					{COLUMNS.map((col) => (
						<Text
							key={col}
							color={status === col ? "cyan" : "dimColor"}
							bold={status === col}
							onClick={() => setStatus(col)}
						>
							[{col}]{" "}
						</Text>
					))}
				</Box>
			</Box>
			<Box marginTop={1}>
				<Text>Description: </Text>
			</Box>
			<TextInput
				value={description}
				onChange={setDescription}
				placeholder="Optional description"
			/>
			<Box marginTop={1}>
				<Text green onClick={() => onSubmit({ title, description, status })}>
					[Enter] Create
				</Text>
				<Text> </Text>
				<Text red onClick={onCancel}>
					[Esc] Cancel
				</Text>
			</Box>
		</Box>
	);
}

export default function TasksScreen({ tasks, wsBridge, refreshMs }) {
	const [selectedColumn, setSelectedColumn] = useState(0);
	const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
	const [showCreate, setShowCreate] = useState(false);
	const [filter, setFilter] = useState("");
	const [mode, setMode] = useState("view");

	const tasksByStatus = COLUMNS.reduce((acc, col) => {
		acc[col] = (tasks || []).filter(
			(t) => t.status === col && (!filter || t.title?.toLowerCase().includes(filter.toLowerCase()))
		);
		return acc;
	}, {});

	const currentColumn = COLUMNS[selectedColumn];
	const currentTasks = tasksByStatus[currentColumn] || [];

	const handleKeyPress = useCallback((key) => {
		if (showCreate) return;

		if (mode === "view") {
			if (key === "h" || key === "arrowLeft") {
				setSelectedColumn((prev) => Math.max(0, prev - 1));
				setSelectedTaskIndex(0);
			}
			if (key === "l" || key === "arrowRight") {
				setSelectedColumn((prev) => Math.min(COLUMNS.length - 1, prev + 1));
				setSelectedTaskIndex(0);
			}
			if (key === "k" || key === "arrowUp") {
				setSelectedTaskIndex((prev) => Math.max(0, prev - 1));
			}
			if (key === "j" || key === "arrowDown") {
				setSelectedTaskIndex((prev) => Math.min(currentTasks.length - 1, prev + 1));
			}
			if (key === "c") {
				setShowCreate(true);
				setMode("create");
			}
			if (key === "/") {
				setMode("filter");
			}
		}

		if (key === "Escape") {
			if (showCreate) {
				setShowCreate(false);
				setMode("view");
			} else if (mode === "filter") {
				setMode("view");
				setFilter("");
			}
		}
	}, [currentTasks.length, mode, showCreate]);

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

	const handleCreateTask = (taskData) => {
		wsBridge.send("task:create", taskData);
		setShowCreate(false);
		setMode("view");
	};

	const handleTaskAction = (action) => {
		const task = currentTasks[selectedTaskIndex];
		if (!task) return;

		wsBridge.send("task:action", {
			taskId: task.id,
			action,
		});
	};

	return (
		<Box flexDirection="column" flexGrow={1} paddingY={1}>
			{mode === "filter" && (
				<Box paddingX={1}>
					<Text>Filter: </Text>
					<TextInput
						value={filter}
						onChange={setFilter}
						placeholder="Type to filter tasks..."
						onSubmit={() => setMode("view")}
					/>
				</Box>
			)}

			<Box flexDirection="row" flexGrow={1}>
				{COLUMNS.map((col, colIdx) => (
					<Box
						key={col}
						flexDirection="column"
						flexGrow={1}
						marginX={1}
						borderStyle={selectedColumn === colIdx ? "bold" : "single"}
						borderDim={selectedColumn !== colIdx}
					>
						<Box
							paddingX={1}
							paddingY={0}
							borderStyle="single"
							borderBottom
							justifyContent="center"
						>
							<Text bold color={STATUS_COLORS[col]}>
								{COLUMN_LABELS[col]} ({tasksByStatus[col]?.length || 0})
							</Text>
						</Box>
						<Box flexDirection="column" flexGrow={1} paddingY={1}>
							{(tasksByStatus[col] || []).slice(0, 10).map((task, taskIdx) => (
								<TaskCard
									key={task.id}
									task={task}
									selected={
										selectedColumn === colIdx && selectedTaskIndex === taskIdx
									}
									onSelect={() => {
										setSelectedColumn(colIdx);
										setSelectedTaskIndex(taskIdx);
									}}
								/>
							))}
							{(!tasksByStatus[col] || tasksByStatus[col].length === 0) && (
								<Text dimColor>No tasks</Text>
							)}
						</Box>
					</Box>
				))}
			</Box>

			{showCreate && (
				<CreateTaskModal
					onSubmit={handleCreateTask}
					onCancel={() => {
						setShowCreate(false);
						setMode("view");
					}}
				/>
			)}

			{!showCreate && currentTasks[selectedTaskIndex] && (
				<Box paddingX={1} borderStyle="single" borderTop>
					<Text dimColor>
						[c] Create [←→] Columns [↑↓] Navigate [/] Filter [Esc] Close
					</Text>
				</Box>
			)}
		</Box>
	);
}
