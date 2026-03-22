import { compactCommandOutputPayload } from "./context-cache.mjs";

function resolveBudgetPolicy(commandResult) {
  const family = String(commandResult?.commandDiagnostics?.family || commandResult?.compactionFamily || commandResult?.commandFamily || "generic");
  const compacted = !!commandResult?.compacted;
  const hasArtifact = !!commandResult?.toolLogId;

  let mode = compacted ? "summary" : "inline";
  if (hasArtifact) mode = compacted ? "artifact+summary" : "artifact";

  let reason = compacted
    ? "output exceeded inline budget and was compacted"
    : "output fit inline budget";

  if (["build", "test", "deploy", "logs"].includes(family) && hasArtifact) {
    reason = "family policy prefers retrievable artifacts plus stable summaries for noisy output";
  } else if (["search", "git"].includes(family)) {
    reason = compacted
      ? "family policy keeps stable excerpts and top deltas inline"
      : "family policy allows inline excerpts for compact output";
  } else if (family === "package-manager") {
    reason = compacted
      ? "package manager output was summarized to dependency deltas"
      : "package manager output was small enough to keep inline";
  }

  return {
    family,
    mode,
    hasArtifact,
    reason,
    retrieveCommand: commandResult?.retrieveCommand || null,
    compactionFamily: commandResult?.compactionFamily || null,
    commandFamily: commandResult?.commandFamily || null,
  };
}

export async function buildContextEnvelope({
  commandPayload = null,
  continuation = null,
  promptContext = null,
  sessionType = "flow",
  agentType = "workflow",
} = {}) {
  const command = commandPayload
    ? await compactCommandOutputPayload(commandPayload, { sessionType, agentType, force: true })
    : null;

  return {
    command: command
      ? {
          family: String(command.commandDiagnostics?.family || command.compactionFamily || command.commandFamily || "generic"),
          runner: command.commandDiagnostics?.runner || null,
          text: command.text,
          compacted: command.compacted,
          diagnostics: command.commandDiagnostics || null,
          budget: resolveBudgetPolicy(command),
          inspect: {
            toolLogId: command.toolLogId,
            retrieveCommand: command.retrieveCommand,
            why: resolveBudgetPolicy(command).reason,
          },
        }
      : null,
    continuation: continuation || null,
    promptContext: promptContext || null,
  };
}
