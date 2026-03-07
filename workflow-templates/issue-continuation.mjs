/**
 * Issue State Continuation Loop Workflow Template
 *
 * This workflow monitors GitHub issues and automatically continues working on them
 * when their state changes (e.g., from "in progress" to "ready for review").
 *
 * It implements a "continuation loop" pattern that:
 * 1. Polls for issues in a specific state
 * 2. When an issue changes state, triggers an agent to work on it
 * 3. Updates the issue state based on work completion
 * 4. Repeats until issue is closed
 *
 * @module workflow-templates/issue-continuation
 */

export const ISSUE_CONTINUATION_LOOP_TEMPLATE = {
	id: "template-issue-continuation-loop",
	name: "Issue Continuation Loop",
	description: "Monitor GitHub issues and automatically continue working when state changes",
	version: "1.0.0",
	category: "automation",
	icon: "🔄",
	metadata: {
		author: "bosun",
		tags: ["github", "issues", "automation", "loop"],
		repoRequired: true,
	},

	variables: {
		repo: {
			type: "string",
			required: true,
			description: "GitHub repository (owner/repo)",
		},
		issueState: {
			type: "string",
			default: "open",
			description: "Issue state to monitor (open, all)",
		},
		issueLabels: {
			type: "string",
			default: "",
			description: "Comma-separated labels to filter issues",
		},
		watchStates: {
			type: "string",
			default: "in_progress,ready_for_review",
			description: "States that trigger continuation",
		},
		pollIntervalMs: {
			type: "number",
			default: 60000,
			description: "How often to poll for state changes (ms)",
		},
		maxConcurrent: {
			type: "number",
			default: 3,
			description: "Maximum concurrent issue workflows",
		},
		assignOnStart: {
			type: "boolean",
			default: true,
			description: "Assign issue to bot when starting work",
		},
		commentOnStart: {
			type: "string",
			default: "Starting automated work on this issue.",
			description: "Comment to post when starting work",
		},
		commentOnComplete: {
			type: "string",
			default: "Automated work completed. Ready for review.",
			description: "Comment to post when work is complete",
		},
		botUsername: {
			type: "string",
			default: "bosun[bot]",
			description: "Bot username for assignments",
		},
	},

	triggers: {
		schedule: {
			enabled: true,
			cron: null,
			intervalMs: "{{pollIntervalMs}}",
		},
		manual: {
			enabled: true,
		},
	},

	nodes: [
		{
			id: "check-issues",
			type: "github-list-issues",
			label: "Check Issues",
			config: {
				repo: "{{repo}}",
				state: "{{issueState}}",
				labels: "{{issueLabels}}",
				sort: "updated",
				direction: "desc",
			},
		},
		{
			id: "filter-issues",
			type: "filter",
			label: "Filter by Watch States",
			config: {
				items: "{{check-issues.output}}",
				expression: `((item) => {
					const watchStates = String("{{watchStates}}").split(",").map(s => s.trim());
					const state = String(item.state || "").toLowerCase();
					const label = String(item.labels || "").toLowerCase();
					return watchStates.some(ws => state.includes(ws) || label.includes(ws));
				})`,
			},
		},
		{
			id: "check-already-working",
			type: "filter",
			label: "Filter Out Already Working",
			config: {
				items: "{{filter-issues.output}}",
				expression: `((item) => {
					const assignees = item.assignees || [];
					const botName = String("{{botUsername}}").toLowerCase();
					return !assignees.some(a => String(a.login || a || "").toLowerCase().includes(botName));
				})`,
			},
		},
		{
			id: "limit-concurrent",
			type: "limit",
			label: "Limit Concurrent",
			config: {
				items: "{{check-already-working.output}}",
				limit: "{{maxConcurrent}}",
			},
		},
		{
			id: "for-each-issue",
			type: "for-each",
			label: "Process Each Issue",
			items: "{{limit-concurrent.output}}",
			nodes: [
				{
					id: "assign-issue",
					type: "github-add-issue-assignees",
					label: "Assign Issue",
					condition: "{{assignOnStart}}",
					config: {
						repo: "{{repo}}",
						issueNumber: "{{for-each-issue.item.number}}",
						assignees: ["{{botUsername}}"],
					},
				},
				{
					id: "comment-start",
					type: "github-create-issue-comment",
					label: "Comment on Start",
					condition: "{{commentOnStart}}",
					config: {
						repo: "{{repo}}",
						issueNumber: "{{for-each-issue.item.number}}",
						body: "{{commentOnStart}}",
					},
				},
				{
					id: "analyze-issue",
					type: "agent-prompt",
					label: "Analyze Issue",
					config: {
						prompt: `Analyze this GitHub issue and create a task plan:\n\nTitle: {{for-each-issue.item.title}}\nBody: {{for-each-issue.item.body}}\n\nProvide:\n1. Summary of the issue\n2. Steps to reproduce (if bug)\n3. Proposed solution\n4. Files likely to be modified`,
						executor: "codex",
						model: "auto",
					},
				},
				{
					id: "execute-work",
					type: "agent-execute",
					label: "Execute Work",
					config: {
						prompt: "{{analyze-issue.output}}",
						taskKey: "issue-{{for-each-issue.item.number}}",
						executor: "codex",
						model: "auto",
						timeoutMs: 600000,
					},
				},
				{
					id: "update-issue-state",
					type: "github-update-issue",
					label: "Update Issue State",
					config: {
						repo: "{{repo}}",
						issueNumber: "{{for-each-issue.item.number}}",
						state: "open",
						labels: "{{for-each-issue.item.labels}},in-review",
					},
				},
				{
					id: "comment-complete",
					type: "github-create-issue-comment",
					label: "Comment on Complete",
					condition: "{{commentOnComplete}}",
					config: {
						repo: "{{repo}}",
						issueNumber: "{{for-each-issue.item.number}}",
						body: "{{commentOnComplete}}\n\n---\nWork completed by Bosun.\n{{execute-work.output}}",
					},
				},
			],
		},
		{
			id: "wait",
			type: "delay",
			label: "Wait Before Next Poll",
			config: {
				delayMs: "{{pollIntervalMs}}",
			},
		},
		{
			id: "loop",
			type: "loop",
			label: "Continue Loop",
			source: "wait",
			target: "check-issues",
		},
	],

	edges: [
		{ source: "check-issues", target: "filter-issues" },
		{ source: "filter-issues", target: "check-already-working" },
		{ source: "check-already-working", target: "limit-concurrent" },
		{ source: "limit-concurrent", target: "for-each-issue" },
		{ source: "for-each-issue", target: "wait" },
		{ source: "wait", target: "loop" },
	],
};

export default ISSUE_CONTINUATION_LOOP_TEMPLATE;
