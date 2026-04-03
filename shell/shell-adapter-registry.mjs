/**
 * Transitional architecture note:
 * Shell-specific executor imports and adapter parity belong in the shell layer.
 * Canonical session, provider, tool, and lifecycle ownership live in harness
 * modules; this file only exposes a thin transport catalog for legacy callers.
 */

import {
  execCodexPrompt,
  steerCodexPrompt,
  isCodexBusy,
  getThreadInfo,
  resetThread,
  initCodexShell,
  getActiveSessionId as getCodexSessionId,
  listSessions as listCodexSessions,
  switchSession as switchCodexSession,
  createSession as createCodexSession,
} from "./codex-shell.mjs";
import {
  execCopilotPrompt,
  steerCopilotPrompt,
  isCopilotBusy,
  getSessionInfo as getCopilotSessionInfo,
  resetSession as resetCopilotSession,
  initCopilotShell,
} from "./copilot-shell.mjs";
import {
  execClaudePrompt,
  steerClaudePrompt,
  isClaudeBusy,
  getSessionInfo as getClaudeSessionInfo,
  resetClaudeSession,
  initClaudeShell,
} from "./claude-shell.mjs";
import {
  execOpencodePrompt,
  steerOpencodePrompt,
  isOpencodeBusy,
  getSessionInfo as getOpencodeSessionInfo,
  resetSession as resetOpencodeSession,
  initOpencodeShell,
  getActiveSessionId as getOpencodeSessionId,
  listSessions as listOpencodeSessions,
  switchSession as switchOpencodeSession,
  createSession as createOpencodeSession,
} from "./opencode-shell.mjs";
import {
  execGeminiPrompt,
  steerGeminiPrompt,
  isGeminiBusy,
  getSessionInfo as getGeminiSessionInfo,
  resetSession as resetGeminiSession,
  initGeminiShell,
  getActiveSessionId as getGeminiSessionId,
  listSessions as listGeminiSessions,
  switchSession as switchGeminiSession,
  createSession as createGeminiSession,
} from "./gemini-shell.mjs";

function passthroughRuntimeOptions(_adapterName, options = {}) {
  return options;
}

function applyRuntimeOptions(withRuntimeOptions, adapterName, options = {}) {
  const resolved = withRuntimeOptions(adapterName, options);
  return resolved && typeof resolved === "object" ? resolved : options;
}

export function createShellAdapterRegistry(options = {}) {
  const withRuntimeOptions =
    typeof options.withRuntimeOptions === "function"
      ? options.withRuntimeOptions
      : passthroughRuntimeOptions;

  return {
    "codex-sdk": {
      name: "codex-sdk",
      provider: "CODEX",
      displayName: "Codex",
      exec: (msg, execOptions) => execCodexPrompt(msg, { persistent: true, ...execOptions }),
      steer: steerCodexPrompt,
      isBusy: isCodexBusy,
      getInfo: () => {
        const info = getThreadInfo();
        return { ...info, sessionId: info.sessionId || info.threadId };
      },
      reset: resetThread,
      init: async () => {
        await initCodexShell();
        return true;
      },
      getSessionId: getCodexSessionId,
      listSessions: listCodexSessions,
      switchSession: switchCodexSession,
      createSession: createCodexSession,
      sdkCommands: ["/compact", "/status", "/context", "/mcp", "/model", "/clear"],
      async execSdkCommand(command, args, commandOptions = {}) {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        if (cmd === "/clear") {
          await resetThread();
          return "Session cleared.";
        }
        const fullCmd = args ? `${cmd} ${args}` : cmd;
        return execCodexPrompt(fullCmd, {
          persistent: true,
          cwd: commandOptions.cwd,
          sessionId: commandOptions.sessionId || null,
        });
      },
    },
    "copilot-sdk": {
      name: "copilot-sdk",
      provider: "COPILOT",
      displayName: "Copilot",
      exec: (msg, execOptions) => execCopilotPrompt(msg, { persistent: true, ...execOptions }),
      steer: steerCopilotPrompt,
      isBusy: isCopilotBusy,
      getInfo: () => getCopilotSessionInfo(),
      reset: resetCopilotSession,
      init: async () => initCopilotShell(),
      sdkCommands: ["/status", "/model", "/clear"],
      async execSdkCommand(command, args, commandOptions = {}) {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        if (cmd === "/clear") {
          await resetCopilotSession();
          return "Session cleared.";
        }
        const fullCmd = args ? `${cmd} ${args}` : cmd;
        return execCopilotPrompt(fullCmd, {
          persistent: true,
          cwd: commandOptions.cwd,
          sessionId: commandOptions.sessionId || null,
        });
      },
    },
    "claude-sdk": {
      name: "claude-sdk",
      provider: "CLAUDE",
      displayName: "Claude",
      exec: execClaudePrompt,
      steer: steerClaudePrompt,
      isBusy: isClaudeBusy,
      getInfo: () => getClaudeSessionInfo(),
      reset: resetClaudeSession,
      init: async () => {
        await initClaudeShell();
        return true;
      },
      sdkCommands: ["/compact", "/status", "/model", "/clear"],
      async execSdkCommand(command, args, commandOptions = {}) {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        if (cmd === "/clear") {
          await resetClaudeSession();
          return "Session cleared.";
        }
        const fullCmd = args ? `${cmd} ${args}` : cmd;
        return execClaudePrompt(fullCmd, {
          cwd: commandOptions.cwd,
          sessionId: commandOptions.sessionId || null,
        });
      },
    },
    "gemini-sdk": {
      name: "gemini-sdk",
      provider: "GEMINI",
      displayName: "Gemini",
      exec: (msg, execOptions) => execGeminiPrompt(msg, { persistent: true, ...execOptions }),
      steer: steerGeminiPrompt,
      isBusy: isGeminiBusy,
      getInfo: () => getGeminiSessionInfo(),
      reset: resetGeminiSession,
      init: async () => initGeminiShell(),
      getSessionId: getGeminiSessionId,
      listSessions: listGeminiSessions,
      switchSession: switchGeminiSession,
      createSession: createGeminiSession,
      sdkCommands: ["/status", "/model", "/clear"],
      async execSdkCommand(command, args, commandOptions = {}) {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        if (cmd === "/clear") {
          await resetGeminiSession();
          return "Session cleared.";
        }
        const fullCmd = args ? `${cmd} ${args}` : cmd;
        return execGeminiPrompt(fullCmd, {
          persistent: true,
          cwd: commandOptions.cwd,
          sessionId: commandOptions.sessionId || null,
        });
      },
    },
    "opencode-sdk": {
      name: "opencode-sdk",
      provider: "OPENCODE",
      displayName: "OpenCode",
      exec: (msg, execOptions) => execOpencodePrompt(
        msg,
        applyRuntimeOptions(withRuntimeOptions, "opencode-sdk", {
          persistent: true,
          expectedPrimary: "opencode",
          ...execOptions,
        }),
      ),
      steer: (message) => steerOpencodePrompt(message, { expectedPrimary: "opencode" }),
      isBusy: isOpencodeBusy,
      getInfo: () => getOpencodeSessionInfo(),
      reset: resetOpencodeSession,
      init: async () => {
        await initOpencodeShell();
        return true;
      },
      getSessionId: getOpencodeSessionId,
      listSessions: listOpencodeSessions,
      switchSession: switchOpencodeSession,
      createSession: createOpencodeSession,
      sdkCommands: ["/status", "/model", "/sessions", "/clear"],
      async execSdkCommand(command, args, commandOptions = {}) {
        const cmd = command.startsWith("/") ? command : `/${command}`;
        if (cmd === "/clear") {
          await resetOpencodeSession();
          return "Session cleared.";
        }
        const fullCmd = args ? `${cmd} ${args}` : cmd;
        return execOpencodePrompt(
          fullCmd,
          applyRuntimeOptions(withRuntimeOptions, "opencode-sdk", {
            persistent: true,
            expectedPrimary: "opencode",
            cwd: commandOptions.cwd,
            sessionId: commandOptions.sessionId || null,
          }),
        );
      },
    },
  };
}

export default createShellAdapterRegistry;
