import * as defaultAgentPool from "./agent-pool.mjs";

function normalizeAgentPool(pool = {}) {
  return {
    continueSession:
      typeof pool.continueSession === "function"
        ? pool.continueSession.bind(pool)
        : defaultAgentPool.continueSession,
    execWithRetry:
      typeof pool.execWithRetry === "function"
        ? pool.execWithRetry.bind(pool)
        : defaultAgentPool.execWithRetry,
    launchOrResumeThread:
      typeof pool.launchOrResumeThread === "function"
        ? pool.launchOrResumeThread.bind(pool)
        : defaultAgentPool.launchOrResumeThread,
    launchEphemeralThread:
      typeof pool.launchEphemeralThread === "function"
        ? pool.launchEphemeralThread.bind(pool)
        : defaultAgentPool.launchEphemeralThread,
    killSession:
      typeof pool.killSession === "function"
        ? pool.killSession.bind(pool)
        : async (sessionId) => {
            if (!sessionId) return false;
            try {
              defaultAgentPool.invalidateThread(sessionId);
              return true;
            } catch {
              return false;
            }
          },
  };
}

export function createHarnessAgentService(options = {}) {
  const agentPool = normalizeAgentPool(options.agentPool || {});

  return {
    async runTask(prompt, input = {}) {
      const cwd = input.cwd || process.cwd();
      const timeoutMs = Number(input.timeoutMs || input.timeout || 60 * 60 * 1000);
      const taskKey = input.taskKey || null;
      const launchOptions = {
        ...input,
        timeoutMs,
      };

      if (input.autoRecover !== false && typeof agentPool.execWithRetry === "function") {
        return await agentPool.execWithRetry(prompt, launchOptions);
      }
      if (taskKey && typeof agentPool.launchOrResumeThread === "function") {
        return await agentPool.launchOrResumeThread(prompt, cwd, timeoutMs, launchOptions);
      }
      return await agentPool.launchEphemeralThread(prompt, cwd, timeoutMs, launchOptions);
    },

    async continueSession(sessionId, prompt, options = {}) {
      return await agentPool.continueSession(sessionId, prompt, options);
    },

    async killSession(sessionId) {
      return await agentPool.killSession(sessionId);
    },
  };
}

export default createHarnessAgentService;
