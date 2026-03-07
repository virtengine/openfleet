/**
 * Pipeline Orchestration Primitives
 *
 * Declarative multi-agent workflows with:
 * - Pipeline stages
 * - Parallel execution
 * - Conditional branching
 * - Data passing between stages
 * - Rollback support
 *
 * @module pipeline
 */

class PipelineStage {
	constructor(config) {
		this.id = config.id;
		this.name = config.name || config.id;
		this.executor = config.executor || "codex";
		this.model = config.model || "auto";
		this.prompt = config.prompt || "";
		this.parallel = config.parallel || false;
		this.dependsOn = config.dependsOn || [];
		this.condition = config.condition || null;
		this.timeout = config.timeout || 300000;
		this.retry = config.retry || { attempts: 1, delay: 0 };
		this.onSuccess = config.onSuccess || null;
		this.onFailure = config.onFailure || null;
		this.inputMapping = config.inputMapping || {};
		this.outputKey = config.outputKey || this.id;
	}

	async execute(context, previousStages, pipeline) {
		if (this.condition && !this.evaluateCondition(context, previousStages)) {
			pipeline.log(`Stage ${this.id} skipped (condition not met)`);
			return { skipped: true };
		}

		const input = this.resolveInput(context, previousStages);
		const prompt = this.resolvePrompt(input, previousStages);

		pipeline.log(`Executing stage ${this.id} with executor ${this.executor}`);

		let lastError;
		for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
			try {
				if (attempt > 1 && this.retry.delay > 0) {
					await new Promise((r) => setTimeout(r, this.retry.delay));
				}

				const result = await pipeline.executeAgent(
					this.executor,
					prompt,
					{
						taskKey: `${pipeline.id}-${this.id}`,
						model: this.model,
						timeout: this.timeout,
					},
				);

				const output = { [this.outputKey]: result };
				pipeline.log(`Stage ${this.id} completed successfully`);

				if (this.onSuccess) {
					await this.runHook(this.onSuccess, context, output, pipeline);
				}

				return { success: true, output };
			} catch (err) {
				lastError = err;
				pipeline.log(`Stage ${this.id} attempt ${attempt} failed: ${err.message}`);
			}
		}

		if (this.onFailure) {
			await this.runHook(this.onFailure, context, { error: lastError }, pipeline);
		}

		return { success: false, error: lastError };
	}

	evaluateCondition(context, previousStages) {
		if (!this.condition) return true;

		try {
			const fn = new Function("context", "stages", `return (${this.condition})`);
			return fn(context, previousStages);
		} catch {
			return false;
		}
	}

	resolveInput(context, previousStages) {
		const input = {};
		for (const [key, source] of Object.entries(this.inputMapping)) {
			if (source.startsWith("stages.")) {
				const stageId = source.slice(7);
				const stageOutput = previousStages.find((s) => s.id === stageId)?.output;
				if (stageOutput) {
					input[key] = stageOutput[stageId];
				}
			} else if (source.startsWith("context.")) {
				input[key] = context[source.slice(8)];
			} else {
				input[key] = source;
			}
		}
		return input;
	}

	resolvePrompt(input, previousStages) {
		let prompt = this.prompt;

		for (const [key, value] of Object.entries(input)) {
			prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), JSON.stringify(value));
		}

		for (const stage of previousStages) {
			if (stage.output) {
				prompt = prompt.replace(
					new RegExp(`\\{\\{stages\\.${stage.id}\\}\\}`, "g"),
					JSON.stringify(stage.output),
				);
			}
		}

		return prompt;
	}

	async runHook(hook, context, output, pipeline) {
		if (typeof hook === "string") {
			if (hook.startsWith("http://") || hook.startsWith("https://")) {
				await fetch(hook, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ context, output }),
				});
			}
		} else if (typeof hook === "function") {
			await hook(context, output, pipeline);
		}
	}
}

class Pipeline {
	constructor(config) {
		this.id = config.id || `pipeline-${Date.now()}`;
		this.name = config.name || this.id;
		this.stages = (config.stages || []).map((s) => new PipelineStage(s));
		this.context = config.context || {};
		this.variables = config.variables || {};
		this.rollbackEnabled = config.rollback !== false;
		this.rollbackStages = (config.rollbackStages || []).map((s) => new PipelineStage(s));
		this.listeners = {
			start: [],
			stageStart: [],
			stageComplete: [],
			complete: [],
			error: [],
		};
		this.results = {
			stages: [],
			startTime: null,
			endTime: null,
			status: "pending",
		};
		this._log = config.log || (() => {});
	}

	on(event, callback) {
		if (this.listeners[event]) {
			this.listeners[event].push(callback);
		}
		return this;
	}

	async run() {
		this.results.startTime = Date.now();
		this.results.status = "running";
		this._log(`Starting pipeline ${this.name}`);

		for (const cb of this.listeners.start) {
			await cb(this);
		}

		const executedStages = [];
		const stageMap = new Map(this.stages.map((s) => [s.id, s]));

		while (executedStages.length < this.stages.length) {
			const readyStage = this.stages.find((stage) => {
				if (executedStages.find((s) => s.id === stage.id)) return false;
				return stage.dependsOn.every((depId) =>
					executedStages.find((s) => s.id === depId && s.result.success)
				);
			});

			if (!readyStage) {
				const remaining = this.stages.filter((s) => !executedStages.find((e) => e.id === s.id));
				throw new Error(
					`Pipeline blocked: no stages ready to execute. Remaining: ${remaining.map((s) => s.id).join(", ")}`,
				);
			}

			for (const cb of this.listeners.stageStart) {
				await cb(readyStage, this);
			}

			this._log(`Running stage: ${readyStage.id}`);
			const result = await readyStage.execute(this.context, executedStages, this);

			executedStages.push({
				id: readyStage.id,
				name: readyStage.name,
				result,
				output: result.output || {},
			});

			this.results.stages.push(executedStages[executedStages.length - 1]);

			for (const cb of this.listeners.stageComplete) {
				await cb(readyStage, result, this);
			}

			if (!result.success && !result.skipped) {
				this.results.status = "failed";
				this.results.endTime = Date.now();
				this._log(`Pipeline failed at stage ${readyStage.id}`);

				for (const cb of this.listeners.error) {
					await cb(readyStage, result.error, this);
				}

				if (this.rollbackEnabled) {
					await this.rollback();
				}

				return this.results;
			}
		}

		this.results.status = "success";
		this.results.endTime = Date.now();
		this._log(`Pipeline ${this.name} completed successfully`);

		for (const cb of this.listeners.complete) {
			await cb(this.results, this);
		}

		return this.results;
	}

	async rollback() {
		this._log(`Rolling back pipeline ${this.name}`);

		for (const stage of this.rollbackStages) {
			try {
				this._log(`Rolling back with stage: ${stage.id}`);
				await stage.execute(this.context, [], this);
			} catch (err) {
				this._log(`Rollback stage ${stage.id} failed: ${err.message}`);
			}
		}
	}

	async executeAgent(executor, prompt, options) {
		throw new Error("executeAgent must be implemented by subclass or provided via options");
	}

	log(message) {
		this._log(`[${this.name}] ${message}`);
	}
}

function createPipeline(config) {
	return new Pipeline(config);
}

function parsePipelineDefinition(definition) {
	if (typeof definition === "string") {
		try {
			definition = JSON.parse(definition);
		} catch {
			throw new Error("Invalid pipeline definition: must be valid JSON");
		}
	}

	const stages = (definition.stages || []).map((stage) => ({
		id: stage.id || stage.name,
		name: stage.name,
		executor: stage.executor || stage.agent || "codex",
		model: stage.model,
		prompt: stage.prompt || stage.task || stage.command || "",
		dependsOn: stage.dependsOn || stage.requires || [],
		condition: stage.condition,
		timeout: stage.timeout || stage.timeoutMs,
		retry: stage.retry || { attempts: stage.retries || 1, delay: stage.retryDelay || 0 },
		inputMapping: stage.input || stage.inputMapping || {},
		outputKey: stage.output || stage.outputKey || stage.id,
		parallel: stage.parallel || false,
		onSuccess: stage.onSuccess || stage.successHook,
		onFailure: stage.onFailure || stage.failureHook,
	}));

	return {
		id: definition.id || definition.name || `pipeline-${Date.now()}`,
		name: definition.name || definition.id,
		stages,
		context: definition.context || {},
		variables: definition.variables || {},
		rollback: definition.rollback !== false,
		rollbackStages: (definition.rollbackStages || []).map((stage) => ({
			id: stage.id || stage.name,
			executor: stage.executor || "codex",
			prompt: stage.prompt || stage.command || "",
		})),
	};
}

export { Pipeline, PipelineStage, createPipeline, parsePipelineDefinition };
export default { Pipeline, PipelineStage, createPipeline, parsePipelineDefinition };
