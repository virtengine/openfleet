import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  clearThreadRegistry,
  getThreadRecord,
  launchOrResumeThread,
} from "../scripts/bosun/agents/agent-pool.mjs";

const ENV_KEYS = [
  "CODEX_SDK_DISABLED",
  "COPILOT_SDK_DISABLED",
  "CLAUDE_SDK_DISABLED",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "COPILOT_CLI_TOKEN",
  "GITHUB_TOKEN",
];

let envSnapshot = {};

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function disableAllSdks() {
  process.env.CODEX_SDK_DISABLED = "1";
  process.env.COPILOT_SDK_DISABLED = "1";
  process.env.CLAUDE_SDK_DISABLED = "1";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.COPILOT_CLI_TOKEN;
  delete process.env.GITHUB_TOKEN;
}

beforeEach(() => {
  envSnapshot = snapshotEnv();
  disableAllSdks();
  clearThreadRegistry();
});

afterEach(() => {
  clearThreadRegistry();
  restoreEnv(envSnapshot);
});

test("launchOrResumeThread handles null extra without throwing TypeError", async () => {
  await assert.doesNotReject(async () => {
    const result = await launchOrResumeThread(
      "null-extra regression guard",
      process.cwd(),
      25,
      null,
    );
    assert.equal(typeof result, "object");
    assert.equal(result.resumed, false);
    assert.match(String(result.error || ""), /no SDK available/i);
  });
});

test("launchOrResumeThread ignores array extras and does not create task records from them", async () => {
  const taskKey = "array-extra-task-key";
  const arrayExtra = [];
  arrayExtra.taskKey = taskKey;

  const result = await launchOrResumeThread(
    "array-extra regression guard",
    process.cwd(),
    25,
    arrayExtra,
  );

  assert.equal(result.resumed, false);
  assert.equal(getThreadRecord(taskKey), null);
});

test("launchOrResumeThread preserves object extras and still records task state", async () => {
  const taskKey = "object-extra-task-key";

  const result = await launchOrResumeThread(
    "object-extra behavior",
    process.cwd(),
    25,
    { taskKey },
  );

  assert.equal(result.resumed, false);

  const record = getThreadRecord(taskKey);
  assert.ok(record, "task record should be created for object extras");
  assert.equal(record.taskKey, taskKey);
  assert.equal(record.alive, false);
  assert.equal(typeof record.turnCount, "number");
});
