# VK Session Log Failure Pattern Catalog

> **Source**: 30 VK session log files from `2026-02-09T14:17–15:40 UTC`
> **Purpose**: Plaintext patterns for real-time openfleet detection
> **Log formats**: Copilot/VK (JSON-line `{"ToolCall":...}`) and Codex (JSON-RPC `{"method":"codex/event/..."}`)

---

## Session Inventory

| Process ID | Restarts | Task                                        | Outcome        |
| ---------- | -------- | ------------------------------------------- | -------------- |
| 25d170b7   | 3x       | test(portal): escrow governance billing 41A | COMPLETED      |
| 7c6fb178   | 3x       | feat(settlement): Adyen PayPal ACH 49C      | TRUNCATED      |
| ee9f5218   | 3x       | test(take): fee deduction tests 37B         | STREAM_ERROR   |
| dff9da37   | 3x       | feat(provider): domain verification 47A     | TRUNCATED      |
| f70ec6b2   | 2x       | Plan next tasks (backlog-per-capita)        | TRUNCATED      |
| 33097e4a   | 1x       | ci: smoke test DR failover 42B              | DONE           |
| 02136830   | 1x       | fix(settlement): register gRPC server 46A   | TRUNCATED      |
| 9fda0169   | 1x       | test(mobile): VEID capture tests 41D        | STREAM_ERROR   |
| 6f402ac3   | 1x       | ci: gosec gitleaks blocking 42A             | DONE           |
| e6331dc1   | 1x       | Plan next tasks (backlog-per-capita)        | DONE           |
| 9c9e2129   | 1x       | Plan next tasks (backlog-per-capita)        | DONE           |
| 85028c71   | 1x       | feat(mfa): trusted browser 47B              | TRUNCATED      |
| 6ab75158   | 1x       | feat(settlement): BillingKeeper wiring      | TRUNCATED      |
| 2af89875   | 1x       | test(take): fee deduction tests             | TOKEN_OVERFLOW |
| 71ed360c   | 1x       | test(take): fee deduction tests             | TOKEN_OVERFLOW |
| a921d212   | 1x       | test(take): fee deduction tests             | TOKEN_OVERFLOW |
| b0ff9e9f   | 1x       | feat(settlement): Adyen PayPal ACH          | TOKEN_OVERFLOW |
| 9bb96987   | 1x       | test(take): fee deduction tests             | TOKEN_OVERFLOW |
| c3f151fa   | 1x       | feat(settlement): Adyen PayPal ACH          | TOKEN_OVERFLOW |
| be3753a6   | 1x       | feat(settlement): Adyen PayPal ACH          | TOKEN_OVERFLOW |
| 1ae872f9   | 1x       | test(take): fee deduction tests             | TOKEN_OVERFLOW |

**Outcomes**: 1 COMPLETED, 4 DONE, 2 STREAM_ERROR, 8 TOKEN_OVERFLOW, 6 TRUNCATED (killed mid-execution)

---

## Category 1: Token Limit Overflow (Instant Death)

**Severity**: CRITICAL — session produces zero useful work
**Frequency**: 8/21 unique sessions (38%)

### Pattern

The initial prompt exceeds the model's context window limit. Session dies on first API call after 5 retries (~6 seconds total).

### Detection Strings (plaintext)

```
"CAPIError: 400 prompt token count of"
"exceeds the limit of"
"retried 5 times (total retry wait time:"
```

### Regex Pattern

```
CAPIError: 400 prompt token count of (\d+) exceeds the limit of (\d+)
```

### Observed Values

| Session  | Token Count | Limit   | Overflow |
| -------- | ----------- | ------- | -------- |
| 2af89875 | 292,514     | 272,000 | +20,514  |
| 71ed360c | 293,198     | 272,000 | +21,198  |
| a921d212 | 293,967     | 272,000 | +21,967  |
| 9bb96987 | 295,666     | 272,000 | +23,666  |
| 1ae872f9 | 297,326     | 272,000 | +25,326  |
| b0ff9e9f | 537,965     | 272,000 | +265,965 |
| c3f151fa | 538,832     | 272,000 | +266,832 |
| be3753a6 | 539,879     | 272,000 | +267,879 |

Two distinct clusters: ~293K tokens (small overflow ~20K) and ~538K tokens (massive overflow ~266K). The 538K sessions have nearly 2x the limit — likely the task description plus massive repo context injection.

### Log Structure (Copilot format)

```json
{"SessionStart":"<uuid>"}
{"User":"<massive task prompt>"}
{"Message":{"type":"text","text":"Error: Execution failed: Error: Failed to get response from the AI model; retried 5 times (total retry wait time: X.XX seconds) ... Last error: CAPIError: 400 prompt token count of NNNNN exceeds the limit of 272000"}}
{"Done":"\"end_turn\""}
```

### Monitor Action

- **Detect**: First `Message` event contains `CAPIError: 400 prompt token count`
- **Metric**: Extract token count and limit for alerting
- **Response**: Kill process immediately, flag task for prompt reduction

---

## Category 2: Unsupported Model Error (Subagent Death)

**Severity**: HIGH — subagent calls fail, parent agent wastes 90+ seconds per attempt
**Frequency**: 6 sessions affected (dff9da37 x3, 9fda0169, e6331dc1, 85028c71, 9c9e2129)

### Pattern

Parent agent spawns a subagent tool call. The subagent's model is not available. Each attempt retries 5x with ~90 second wait before failing.

### Detection Strings (plaintext)

```
"CAPIError: 400 The requested model is not supported"
"Failed to get response from the AI model; retried 5 times"
"total retry wait time:"
```

### Log Structure (Copilot format — subagent failure)

```json
{
  "ToolUpdate": {
    "toolCallId": "<id>",
    "status": "failed",
    "rawOutput": {
      "message": "Error: Failed to get response from the AI model; retried 5 times (total retry wait time: 94.XX seconds) (Request-ID XX:XX:XX:XX:XX) Last error: CAPIError: 400 The requested model is not supported."
    }
  }
}
```

### Observed Timing

- Retry wait times: 85–100 seconds per subagent attempt
- Multiple subagent calls in same session = multiplicative waste
- e6331dc1 had 4 consecutive subagent failures = ~360 seconds wasted

### Monitor Action

- **Detect**: `"status":"failed"` + `CAPIError: 400 The requested model is not supported`
- **Metric**: Count per session, track cumulative retry wait time
- **Response**: After 2+ model failures, alert — model configuration is wrong

---

## Category 3: Stream Completion Error

**Severity**: HIGH — agent dies mid-execution with no recoverable state
**Frequency**: 2 sessions (ee9f5218, 9fda0169)

### Detection String (plaintext)

```
"Stream completed without a response.completed event"
```

### Log Structure

```json
{"Message":{"type":"text","text":"Error: Execution failed: Error: Stream completed without a response.completed event"}}
{"Done":"\"end_turn\""}
```

### Monitor Action

- **Detect**: `Stream completed without a response.completed event`
- **Response**: Session is dead, restart needed

---

## Category 4: Session Truncation (Killed Mid-Execution)

**Severity**: HIGH — work in progress lost, no summary produced
**Frequency**: 6 sessions (7c6fb178, dff9da37, 25d170b7 x2, f70ec6b2, 02136830, 85028c71, 6ab75158)

### Pattern

Session log ends mid-tool-call or mid-reasoning without a `"Done"` or `"task_complete"` event. The VK orchestrator killed the process (timeout or restart).

### Detection Logic

```
Session has NO line matching: "Done" or "task_complete"
AND session has > 100 lines (not a token-overflow instant death)
AND last line is a ToolCall, ToolUpdate, or reasoning event
```

### Detection Strings — Absence Detection

```
# Session should end with one of:
{"Done":"\"end_turn\""}
"type":"task_complete"

# If NEITHER appears and session has substantial content, it was truncated/killed
```

### Last Line Indicators (what truncated sessions end with)

```json
{"ToolCall":{"toolCallId":"...","title":"read_powershell","kind":"execute",...}}
{"ToolUpdate":{"toolCallId":"...","status":"completed",...}}
{"method":"item/commandExecution/outputDelta",...}
{"method":"item/completed","params":{"item":{"type":"reasoning",...}}}
```

### Monitor Action

- **Detect**: Process exit without `Done` or `task_complete` in last 5 lines
- **Response**: Mark as incomplete, check if restart file exists

---

## Category 5: Death Loops (Repeated Restarts)

**Severity**: HIGH — same task restarts multiple times, often making the same progress and hitting the same wall
**Frequency**: 5 process IDs with restarts (7c6fb178 3x, ee9f5218 3x, 25d170b7 3x, dff9da37 3x, f70ec6b2 2x)

### Pattern

The VK orchestrator restarts a session. A new log file appears with the same session ID prefix but a later timestamp. The content across restarts is often nearly identical (same tool calls, same file reads, same patterns).

### Detection — Multiple Files for Same Process

```
# Files sharing the same 8-char process ID suffix:
vk-session-2026-02-09T14-17-26-610Z-7c6fb178.log  (4385 lines)
vk-session-2026-02-09T14-41-59-172Z-7c6fb178.log  (4469 lines)
vk-session-2026-02-09T14-47-53-610Z-7c6fb178.log  (6041 lines)
```

### Detection Logic

```
Multiple log files with identical process-ID suffix
AND file size/line counts are similar (±20%)
AND no "task_complete" in any of them (except possibly the last)
```

### Escalation Evidence

| Process  | Files | Lines per file | Final outcome       |
| -------- | ----- | -------------- | ------------------- |
| 25d170b7 | 3     | 53K→55K→56K    | COMPLETED (3rd try) |
| 7c6fb178 | 3     | 4.4K→4.5K→6K   | TRUNCATED (all 3)   |
| ee9f5218 | 3     | 3.8K→4.6K→5.2K | STREAM_ERROR (3rd)  |
| dff9da37 | 3     | 1.2K→1.3K→5.2K | TRUNCATED (all 3)   |
| f70ec6b2 | 2     | 723→7.6K       | TRUNCATED (both)    |

### Monitor Action

- **Detect**: Same process ID appearing in 3+ log files
- **Metric**: Track restart count and total execution time across restarts
- **Response**: After 3 restarts without completion, escalate to human

---

## Category 6: Tool Call Failures

**Severity**: MEDIUM — each failure wastes a turn; cascading failures indicate deeper problems

### 6a. Path Does Not Exist (File Not Found)

**Frequency**: 15 occurrences across sessions

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": { "message": "Path does not exist", "code": "failure" }
  }
}
```

**Detection string**: `"Path does not exist"`

### 6b. Multiple Matches Found (Ambiguous Edit)

**Frequency**: 16 occurrences

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": { "message": "Multiple matches found", "code": "failure" }
  }
}
```

**Detection string**: `"Multiple matches found"`

### 6c. No Match Found (Stale Edit Target)

**Frequency**: 10 occurrences

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": { "message": "No match found", "code": "failure" }
  }
}
```

**Detection string**: `"No match found"`

### 6d. Failed Patch Application

**Frequency**: 4 occurrences

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": {
      "message": "Failed to apply patch: Error: Failed to find expected lines in ..."
    }
  }
}
```

**Detection string**: `"Failed to apply patch"`

### 6e. Invalid Shell ID

**Frequency**: 4 occurrences (3x "shellId: 7", 1x "shellId: 21")

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": {
      "message": "Invalid shell ID: 7. Please supply a valid shell ID to read output from.\n\n<no active shell sessions>",
      "code": "failure"
    }
  }
}
```

**Detection strings**:

```
"Invalid shell ID:"
"Expected string, received number"
"<no active shell sessions>"
```

### 6f. Path Already Exists

**Frequency**: 1 occurrence

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": { "message": "Path already exists", "code": "failure" }
  }
}
```

### 6g. Ripgrep IO Error

**Frequency**: 3 occurrences

```json
{
  "ToolUpdate": {
    "toolCallId": "...",
    "status": "failed",
    "rawOutput": {
      "message": "rg: C:\\...\\msg.pb.go: IO error for operation on ..."
    }
  }
}
```

**Detection string**: `"rg:"` + `"IO error"`

### Monitor Action for All Tool Failures

- **Detect**: `"status":"failed"` in `ToolUpdate` events
- **Metric**: Count failures per session; alert when >10 failures
- **Threshold**: 3+ consecutive same-tool failures = potential loop

---

## Category 7: Command Execution Failures (Codex Format)

**Severity**: MEDIUM — agent wastes turns debugging command syntax
**Frequency**: 25d170b7 had 22 failures, 02136830 had 16 failures

### 7a. Grep Quoting Failure (Windows/Bash Incompatibility)

The Codex agent runs `bash -lc` commands with grep, but quoting breaks on Windows.

```json
{
  "method": "item/completed",
  "params": {
    "item": {
      "type": "commandExecution",
      "status": "failed",
      "command": "...",
      "exitCode": 1,
      "aggregatedOutput": "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n"
    }
  }
}
```

**Detection strings**:

```
"exitCode":1
"Usage: grep [OPTION]... PATTERNS [FILE]..."
"status":"failed"
"type":"commandExecution"
```

### 7b. Grep Trailing Backslash

```
"aggregatedOutput":"grep: Trailing backslash\n"
```

**Detection string**: `"grep: Trailing backslash"`

### 7c. General Command Failure (Non-Zero Exit)

**Detection (Codex format)**:

```json
{"method":"item/completed","params":{"item":{"type":"commandExecution","status":"failed","exitCode":N,...}}}
```

**Detection regex**:

```
"type":"commandExecution".*"status":"failed".*"exitCode":[1-9]
```

### Monitor Action

- **Detect**: `"status":"failed"` + `"type":"commandExecution"` + `"exitCode":[1-9]`
- **Metric**: Track command failure rate; alert when >15%
- **Response**: High grep failure rate suggests Windows/bash compat issues

---

## Category 8: Rebase/Merge Conflict Death Spiral

**Severity**: HIGH — agent enters unbounded conflict resolution loop
**Frequency**: f70ec6b2 had 47 rebase commands and 687 conflict mentions

### Pattern

Agent attempts `git rebase --continue` repeatedly, resolving conflicts one at a time, sometimes making the same mistakes repeatedly.

### Detection Strings

```
"git rebase --continue"
"git rebase --abort"
"CONFLICT"
"conflict marker"
"<<<<<<< HEAD"
">>>>>>> "
"======="
```

### Observed in f70ec6b2

```
47 rebase attempts
687 conflict-related lines
6x "Continuing rebase" (repeated thought)
147x "conflict" (repeated thought — highest repeat count in any session)
87x "Continuing rebase" (thought repetition)
```

### Loop Detection

```
# Repeated thought pattern indicating loop:
{"Thought":{"type":"text","text":"Continuing rebase"}}
# Same thought appearing 87+ times = death spiral
```

### Monitor Action

- **Detect**: >10 `"git rebase --continue"` commands in a session
- **Detect**: Same `Thought` text appearing >20 times
- **Response**: Alert after 15 rebase attempts, kill after 30

---

## Category 9: Consecutive Identical Tool Calls (Stalling)

**Severity**: MEDIUM-HIGH — agent is stuck in a loop calling the same tool
**Frequency**: Widespread

### Observed Patterns

| Session  | Max Consecutive | Tool                                |
| -------- | --------------- | ----------------------------------- |
| 33097e4a | 13x             | `apply_patch`                       |
| 7c6fb178 | 10x             | `apply_patch`                       |
| dff9da37 | 18x             | Editing test file                   |
| e6331dc1 | 9x              | Searching `TODO/FIXME/missing spec` |
| ee9f5218 | 6x              | `apply_patch`                       |
| f70ec6b2 | 6x              | `read_powershell`                   |
| 85028c71 | 5x              | `rg`                                |

### Detection (Copilot format)

```json
{"ToolCall":{"toolCallId":"...","title":"<SAME_TITLE>","kind":"execute",...}}
# Consecutive ToolCall events with identical "title" field
```

### Detection (Codex format)

Look for consecutive `item/started` events with the same command pattern.

### Monitor Action

- **Detect**: 5+ consecutive ToolCall events with identical `title`
- **Metric**: Track max consecutive same-tool streak
- **Response**: Alert at 8, kill at 15

---

## Category 10: Git Push / Pre-Push Hook Loop

**Severity**: MEDIUM — agent repeatedly pushes, hitting pre-push quality gates
**Frequency**: 7c6fb178 had 5 push attempts over 3 sessions

### Pattern

Agent runs `git push`, triggers pre-push quality gate, gate runs lint/build/tests, some fail, agent fixes and retries.

### Detection Strings

```
"git push"
"Pre-Push Quality Gate"
"pre-push hook"
"PASSED"
"FAILED"
```

### Observed Push Activity

| Session                | Push Attempts | Push Rejects | Hook Mentions |
| ---------------------- | ------------- | ------------ | ------------- |
| 7c6fb178 (3rd restart) | 5             | 2            | 158           |
| ee9f5218 (3rd restart) | 2             | 0            | 62            |
| 25d170b7 (3rd restart) | 7             | 0            | 18            |
| dff9da37 (3rd restart) | 1             | 4            | 36            |
| 02136830               | 1             | 0            | 25            |

### Monitor Action

- **Detect**: >3 `git push` commands in a single session
- **Detect**: `"rejected"` or `"non-fast-forward"` after push
- **Response**: Alert after 4 push attempts, likely in a fix-push-fail loop

---

## Category 11: Subagent Overhead (Wasteful Spawning)

**Severity**: MEDIUM — each subagent call consumes tokens and time
**Frequency**: dff9da37 had 17 subagent calls in one session

### Detection (Copilot format — subagent spawn)

```json
{"ToolCall":{"toolCallId":"...","title":"...","rawInput":{"prompt":"...","description":"..."}}}
# ToolCall with "prompt" in rawInput = subagent invocation
```

### Observed Subagent Counts

| Session        | Subagent Calls |
| -------------- | -------------- |
| dff9da37 (3rd) | 17             |
| dff9da37 (1st) | 14             |
| dff9da37 (2nd) | 14             |
| e6331dc1       | 11             |
| f70ec6b2       | 10             |
| 85028c71       | 4              |
| 6f402ac3       | 3              |
| 02136830       | 3              |
| 9fda0169       | 2              |
| 9c9e2129       | 2              |

### Monitor Action

- **Detect**: ToolCall with `"prompt"` in `rawInput` (subagent pattern)
- **Metric**: Count subagent calls per session
- **Response**: Alert at >10, especially if subagents are failing (model errors)

---

## Category 12: Self-Debugging Reasoning Loops (Codex Format)

**Severity**: LOW-MEDIUM — agent wastes reasoning turns figuring out tool/env issues
**Frequency**: 3 debug-related reasoning blocks in 25d170b7

### Pattern

Agent's reasoning blocks contain error analysis text instead of task work.

### Detection (Codex format)

```json
{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["**Analyzing grep behavior**..."]}}}
{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["**Troubleshooting grep command**..."]}}}
{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["**Debugging Bash command issues**..."]}}}
```

### Detection Strings in Summary

```
"Analyzing grep behavior"
"Troubleshooting"
"Debugging"
"Retrying"
"Figuring out"
```

### Monitor Action

- **Detect**: Reasoning summaries containing debug/troubleshoot keywords
- **Metric**: Track debug-reasoning proportion vs productive-reasoning
- **Response**: Informational — high debug ratio indicates env/tooling issues

---

## Category 13: Repeated Thought Tokens (Context Pollution)

**Severity**: LOW — streaming artifact, but pattern indicates focus/coherence issues
**Frequency**: All sessions with Copilot format

### Pattern

The `Thought` events are streamed token-by-token. Repeated identical tokens indicate the model is generating repetitive content.

### High-Repetition Indicators

```json
{"Thought":{"type":"text","text":"**\n\nI'm"}}    // 53x in 7c6fb178
{"Thought":{"type":"text","text":" conflict"}}     // 147x in f70ec6b2
{"Thought":{"type":"text","text":"Continuing rebase"}} // 87x in f70ec6b2
```

### Monitor Action

- **Detect**: Same `Thought.text` value appearing >30 times
- **Response**: Informational — useful for detecting when agent is "spinning"

---

## Summary: Detection Priority Matrix

| Priority | Pattern             | Detection String                                      | Action                    |
| -------- | ------------------- | ----------------------------------------------------- | ------------------------- |
| P0       | Token overflow      | `prompt token count of ... exceeds the limit`         | Kill immediately          |
| P0       | Model not supported | `CAPIError: 400 The requested model is not supported` | Kill after 2 failures     |
| P1       | Stream death        | `Stream completed without a response.completed event` | Restart                   |
| P1       | Session truncation  | Absence of `"Done"` or `task_complete`                | Mark incomplete           |
| P1       | Death loop          | Same process-ID in 3+ files                           | Escalate after 3 restarts |
| P1       | Rebase spiral       | >10x `git rebase --continue`                          | Kill after 30 attempts    |
| P2       | Tool call loop      | 5+ consecutive identical `"title"` in ToolCall        | Alert at 8, kill at 15    |
| P2       | Push loop           | >3x `git push` in session                             | Alert at 4                |
| P2       | Subagent waste      | >10 subagent calls                                    | Alert                     |
| P3       | Tool failures       | `"status":"failed"` in ToolUpdate                     | Alert at >10 per session  |
| P3       | Command failures    | `"exitCode":[1-9]`                                    | Alert at >15% rate        |
| P3       | Self-debugging      | Reasoning with "Troubleshooting"/"Debugging"          | Informational             |

---

## Appendix: Log Format Reference

### Copilot/VK Format (most sessions)

```
# VK Session Execution Log
# Timestamp: ...
# Process ID: ...
## VK Agent Output Stream:
{"SessionStart":"<uuid>"}
{"User":"<task prompt>"}
{"Thought":{"type":"text","text":"<token>"}}
{"ToolCall":{"toolCallId":"<id>","title":"<tool>","kind":"execute","rawInput":{...}}}
{"ToolUpdate":{"toolCallId":"<id>","status":"completed|failed","content":[...],"rawOutput":{...}}}
{"Message":{"type":"text","text":"<response text>"}}
{"Done":"\"end_turn\""}
```

### Codex Format (25d170b7, 02136830)

```
# VK Session Execution Log
## VK Agent Output Stream:
{"id":N,"result":{"conversationId":"...","model":"gpt-5.2-codex",...}}
{"method":"codex/event/user_message","params":{"id":"0","msg":{"type":"user_message","message":"..."}}}
{"method":"item/started","params":{"item":{"type":"commandExecution","command":"..."},...}}
{"method":"item/commandExecution/outputDelta","params":{"delta":"...",...}}
{"method":"item/completed","params":{"item":{"type":"commandExecution","status":"completed|failed","exitCode":N,...},...}}
{"method":"item/started","params":{"item":{"type":"reasoning","summary":[...],...},...}}
{"method":"codex/event/task_complete","params":{"msg":{"type":"task_complete","last_agent_message":"..."},...}}
```
