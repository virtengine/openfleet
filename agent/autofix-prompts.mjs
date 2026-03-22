import { resolvePromptTemplate } from "./agent-prompts.mjs";

function buildRecentMessagesContext(recentMessages) {
  if (!recentMessages || !recentMessages.length) return "";
  const msgs = recentMessages.slice(-15);
  return `
## Recent monitor notifications (for context — shows what led to this crash)
${msgs.map((message, index) => `[${index + 1}] ${message}`).join("\n")}
`;
}

export function buildFixPrompt(
  error,
  sourceContext,
  reason,
  recentMessages,
  promptTemplate = "",
) {
  const messagesCtx = buildRecentMessagesContext(recentMessages);

  const fallback = `You are a PowerShell expert fixing a crash in a running orchestrator script.

## Error
Type: ${error.errorType}
File: ${error.file}
Line: ${error.line}${error.column ? `\nColumn: ${error.column}` : ""}
Message: ${error.message}${error.codeLine ? `\nFailing code: ${error.codeLine}` : ""}
Crash reason: ${reason}

## Source context around line ${error.line}
\`\`\`powershell
${sourceContext}
\`\`\`
${messagesCtx}
## Instructions
1. Read the file "${error.file}"
2. Identify the root cause of the error at line ${error.line}
3. Fix ONLY the bug — minimal change, don't refactor unrelated code
4. Common PowerShell pitfalls:
   - \`+=\` on arrays with single items fails — use [List[object]] or @() wrapping
   - \`$a + $b\` on PSObjects fails — iterate and add individually
   - Pipeline output can be a single object, not an array — always wrap with @()
   - \`$null.Method()\` crashes — add null guards
   - Named mutex with "Global\\" prefix fails on non-elevated Windows — use plain names
   - \`$Var:\` is treated as a scope-qualified variable — use \`\${Var}:\` to embed colon in string
   - ParserError: check for syntax issues like unclosed brackets, bad string interpolation
5. Write the fix to the file. Do NOT create new files or refactor other functions.
6. Keep all existing functionality intact.`;
  return resolvePromptTemplate(
    promptTemplate,
    {
      ERROR_TYPE: error.errorType,
      ERROR_FILE: error.file,
      ERROR_LINE: error.line,
      ERROR_COLUMN_LINE: error.column ? `Column: ${error.column}` : "",
      ERROR_MESSAGE: error.message,
      ERROR_CODE_LINE: error.codeLine ? `Failing code: ${error.codeLine}` : "",
      CRASH_REASON: reason,
      SOURCE_CONTEXT: sourceContext,
      RECENT_MESSAGES_CONTEXT: messagesCtx,
    },
    fallback,
  );
}

export function buildFallbackPrompt(
  fallback,
  recentMessages,
  promptTemplate = "",
) {
  const messagesCtx = buildRecentMessagesContext(recentMessages);

  const defaultPrompt = `You are a PowerShell expert analyzing an orchestrator script crash.
No structured error was extracted — the process terminated with: ${fallback.reason}

## Error indicators from log tail
${fallback.errorLines.length > 0 ? fallback.errorLines.join("\n") : "(no explicit error lines detected — possible SIGKILL, OOM, or silent crash)"}

## Last ${Math.min(80, fallback.lineCount)} lines of crash log
\`\`\`
${fallback.tail}
\`\`\`
${messagesCtx}
## Instructions
1. Analyze the log for the root cause of the crash
2. The main orchestrator script is: scripts/bosun/ve-orchestrator.ps1
3. If you can identify a fixable bug, apply a minimal fix to the file
4. Common crash causes:
   - PowerShell syntax errors (\$Var: treated as scope, missing brackets)
   - Array/object operation errors (+=, +, pipeline single-item issues)
   - Null reference errors on optional API responses
   - Infinite loops or stack overflow from recursive calls
   - Exit code 4294967295 = unsigned overflow from uncaught exception
5. If the crash is external (SIGKILL, OOM) with no code bug, do nothing
6. Write any fix directly to the file. Keep existing functionality intact.`;
  return resolvePromptTemplate(
    promptTemplate,
    {
      FALLBACK_REASON: fallback.reason,
      FALLBACK_ERROR_LINES:
        fallback.errorLines.length > 0
          ? fallback.errorLines.join("\n")
          : "(no explicit error lines detected — possible SIGKILL, OOM, or silent crash)",
      FALLBACK_LINE_COUNT: Math.min(80, fallback.lineCount),
      FALLBACK_TAIL: fallback.tail,
      RECENT_MESSAGES_CONTEXT: messagesCtx,
    },
    defaultPrompt,
  );
}

export function buildLoopPrompt(
  errorLine,
  repeatCount,
  recentMessages,
  promptTemplate = "",
) {
  const messagesCtx = buildRecentMessagesContext(recentMessages);

  const defaultPrompt = `You are a PowerShell expert fixing a loop bug in a running orchestrator script.

## Problem
The following error line is repeating ${repeatCount} times in the orchestrator output,
indicating an infinite retry loop that needs to be fixed:

"${errorLine}"

${messagesCtx}

## Instructions
1. The main script is: scripts/bosun/ve-orchestrator.ps1
2. Search for the code that produces this error message
3. Identify why it loops (missing break/continue/return, no state change between iterations, etc.)
4. Fix the loop by adding proper exit conditions, error handling, or state tracking
5. Common loop-causing patterns in this codebase:
   - PR lifecycle handoff repeatedly retried with no diff between branch and base
   - API calls returning the same error repeatedly with no backoff or give-up logic
   - Status not updated after failure → next cycle tries the same thing
   - Missing \`continue\` or state change in foreach loops over tracked attempts
6. Apply a minimal fix. Do NOT refactor unrelated code.
7. Write the fix directly to the file.`;
  return resolvePromptTemplate(
    promptTemplate,
    {
      REPEAT_COUNT: repeatCount,
      ERROR_LINE: errorLine,
      RECENT_MESSAGES_CONTEXT: messagesCtx,
    },
    defaultPrompt,
  );
}
