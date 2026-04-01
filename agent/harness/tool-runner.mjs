export async function createToolRunner(options = {}) {
  const orchestrator = options.toolOrchestrator;
  return {
    listTools() {
      return typeof orchestrator?.listTools === "function" ? orchestrator.listTools() : [];
    },
    async runTool(toolName, args = {}, context = {}) {
      if (typeof orchestrator?.executeTool !== "function") {
        throw new Error("Tool orchestrator is not configured");
      }
      return await orchestrator.executeTool(toolName, args, {
        ...context,
        onEvent: context.onEvent || options.onEvent,
      });
    },
  };
}

export default createToolRunner;
