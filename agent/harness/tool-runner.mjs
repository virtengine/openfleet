export async function createToolRunner(options = {}) {
  const orchestrator = options.toolOrchestrator;
  return {
    listTools() {
      return typeof orchestrator?.listTools === "function" ? orchestrator.listTools() : [];
    },
    async runTool(toolName, args = {}, context = {}) {
      const execute = typeof orchestrator?.executeTool === "function"
        ? orchestrator.executeTool.bind(orchestrator)
        : (typeof orchestrator?.execute === "function" ? orchestrator.execute.bind(orchestrator) : null);
      if (typeof execute !== "function") {
        throw new Error("Tool orchestrator is not configured");
      }
      return await execute(toolName, args, {
        ...context,
        onEvent: context.onEvent || options.onEvent,
      });
    },
  };
}

export default createToolRunner;
