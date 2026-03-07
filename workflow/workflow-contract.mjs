/**
 * workflow-contract.mjs — Per-project WORKFLOW.md runtime contract support
 *
 * Allows projects to define a WORKFLOW.md file that specifies:
 * - Allowed workflow templates
 * - Required checks before workflow execution
 * - Environment variables and secrets
 * - Timeout and retry policies
 *
 * Usage:
 *   WORKFLOW.md in project root:
 *   ```markdown
 *   # Bosun Workflow Contract
 *
 *   # Allowed workflow templates
 *   allowed:
 *     - ci-cd
 *     - security
 *     - task-lifecycle
 *
 *   # Required checks before execution
 *   requires:
 *     - ci: passing
 *     - pr: approved
 *
 *   # Environment variables required
 *   env:
 *     - DEPLOY_BUCKET
 *     - API_KEY
 *
 *   # Timeout overrides (ms)
 *   timeout: 300000
 *   retryLimit: 3
 *   ```
 *
 * @module workflow-contract
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONTRACT = {
	allowed: null,
	requires: [],
	env: [],
	timeout: null,
	retryLimit: null,
	enabled: false,
};

let _contractCache = new Map();

function parseContractMarkdown(content) {
	if (!content || typeof content !== "string") {
		return { ...DEFAULT_CONTRACT };
	}

	const lines = content.split("\n");
	const contract = {
		allowed: null,
		requires: [],
		env: [],
		timeout: null,
		retryLimit: null,
		enabled: true,
	};

	let inAllowed = false;
	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === "# Allowed workflow templates" || trimmed === "## allowed") {
			inAllowed = true;
			continue;
		}
		if (inAllowed && trimmed.startsWith("- ")) {
			contract.allowed = contract.allowed || [];
			contract.allowed.push(trimmed.slice(2).trim());
		}
		if (inAllowed && !trimmed.startsWith("-") && trimmed !== "") {
			inAllowed = false;
		}

		if (trimmed.startsWith("requires:")) {
			const reqs = trimmed.slice(9).trim();
			if (reqs) {
				contract.requires.push(...reqs.split(",").map((r) => r.trim()));
			}
		}

		if (trimmed.startsWith("env:")) {
			const envs = trimmed.slice(4).trim();
			if (envs) {
				contract.env.push(...envs.split(",").map((e) => e.trim()));
			}
		}

		if (trimmed.startsWith("timeout:")) {
			const val = trimmed.slice(8).trim();
			contract.timeout = parseInt(val, 10) || null;
		}

		if (trimmed.startsWith("retryLimit:") || trimmed.startsWith("retry_limit:")) {
			const val = trimmed.includes(":")
				? trimmed.slice(trimmed.indexOf(":") + 1).trim()
				: trimmed.slice(11).trim();
			contract.retryLimit = parseInt(val, 10) || null;
		}
	}

	return contract;
}

function loadContractForProject(projectPath) {
	if (_contractCache.has(projectPath)) {
		return _contractCache.get(projectPath);
	}

	const workflowMdPath = resolve(projectPath, "WORKFLOW.md");

	if (!existsSync(workflowMdPath)) {
		const result = { ...DEFAULT_CONTRACT };
		_contractCache.set(projectPath, result);
		return result;
	}

	try {
		const content = readFileSync(workflowMdPath, "utf8");
		const result = parseContractMarkdown(content);
		_contractCache.set(projectPath, result);
		return result;
	} catch (err) {
		console.warn(`[workflow-contract] failed to load ${workflowMdPath}: ${err.message}`);
		return { ...DEFAULT_CONTRACT };
	}
}

export function getWorkflowContract(projectPath) {
	return loadContractForProject(projectPath);
}

export function isWorkflowAllowed(projectPath, workflowId) {
	const contract = getWorkflowContract(projectPath);

	if (!contract.enabled) {
		return { allowed: true, reason: null };
	}

	if (!contract.allowed || contract.allowed.length === 0) {
		return { allowed: true, reason: null };
	}

	const allowed = contract.allowed.some(
		(allowed) =>
			allowed === workflowId ||
			allowed === workflowId.replace(/^template-/, "") ||
			workflowId.startsWith(allowed),
	);

	return {
		allowed,
		reason: allowed ? null : `Workflow "${workflowId}" not in allowed list: ${contract.allowed.join(", ")}`,
	};
}

export function checkRequiredChecks(projectPath) {
	const contract = getWorkflowContract(projectPath);

	if (!contract.enabled || contract.requires.length === 0) {
		return { satisfied: true, missing: [] };
	}

	const missing = [];

	for (const req of contract.requires) {
		const [checkType, expectedStatus] = req.split(":").map((s) => s.trim());

		if (checkType === "ci") {
			missing.push({ type: "ci", status: expectedStatus, message: "CI status check not implemented" });
		} else if (checkType === "pr") {
			missing.push({ type: "pr", status: expectedStatus, message: "PR status check not implemented" });
		} else if (checkType === "secret" || checkType === "env") {
			const envVar = expectedStatus;
			if (!process.env[envVar]) {
				missing.push({ type: "env", var: envVar, message: `Required env var not set: ${envVar}` });
			}
		}
	}

	return {
		satisfied: missing.length === 0,
		missing,
	};
}

export function getContractTimeout(projectPath, defaultTimeout = 300000) {
	const contract = getWorkflowContract(projectPath);
	return contract.timeout || defaultTimeout;
}

export function getContractRetryLimit(projectPath, defaultLimit = 3) {
	const contract = getWorkflowContract(projectPath);
	return contract.retryLimit || defaultLimit;
}

export function validateContract(projectPath) {
	const contract = getWorkflowContract(projectPath);
	const issues = [];

	if (contract.enabled && contract.env.length > 0) {
		for (const envVar of contract.env) {
			if (!process.env[envVar]) {
				issues.push({ type: "env", var: envVar, severity: "error", message: `Required env var not set: ${envVar}` });
			}
		}
	}

	return {
		valid: issues.length === 0,
		issues,
		contract,
	};
}

export function clearContractCache(projectPath) {
	if (projectPath) {
		_contractCache.delete(projectPath);
	} else {
		_contractCache.clear();
	}
}

export function listAllowedWorkflows(projectPath) {
	const contract = getWorkflowContract(projectPath);
	if (!contract.enabled || !contract.allowed) {
		return null;
	}
	return contract.allowed;
}
