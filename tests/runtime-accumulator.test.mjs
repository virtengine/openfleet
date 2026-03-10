import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  _resetRuntimeAccumulatorForTests,
  addCompletedSession,
  getRuntimeStats,
  getSessionAccumulatorLogPath,
  getTaskLifetimeTotals,
} from "../infra/runtime-accumulator.mjs";

describe("runtime-accumulator", () => {
  it("accumulates completed sessions monotonically across 3 restarts with 2 sessions each", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-runtime-accumulator-"));
    const taskId = "task-restart-accumulator";

    try {
      let expectedAttempts = 0;
      let expectedTokenCount = 0;
      let expectedInputTokens = 0;
      let expectedOutputTokens = 0;
      let expectedDurationMs = 0;
      let previousTotals = null;

      for (let restart = 0; restart < 3; restart += 1) {
        _resetRuntimeAccumulatorForTests({ cacheDir });

        const beforeTotals = getTaskLifetimeTotals(taskId);
        expect(beforeTotals.attemptsCount).toBe(expectedAttempts);
        expect(beforeTotals.tokenCount).toBe(expectedTokenCount);
        expect(beforeTotals.durationMs).toBe(expectedDurationMs);

        for (let index = 0; index < 2; index += 1) {
          const startedAt = Date.now() + restart * 10_000 + index * 100;
          const durationMs = 8_000 + restart * 1_000 + index * 500;
          const inputTokens = 1_000 + restart * 100 + index * 10;
          const outputTokens = 400 + restart * 50 + index * 5;
          const tokenCount = inputTokens + outputTokens;

          addCompletedSession({
            id: `${taskId}-session-${restart}-${index}`,
            sessionId: `${taskId}-session-${restart}-${index}`,
            sessionKey: `${taskId}:restart-${restart}:session-${index}`,
            taskId,
            taskTitle: "Restart accumulation test",
            startedAt,
            endedAt: startedAt + durationMs,
            durationMs,
            tokenCount,
            inputTokens,
            outputTokens,
            status: "completed",
          });

          expectedAttempts += 1;
          expectedTokenCount += tokenCount;
          expectedInputTokens += inputTokens;
          expectedOutputTokens += outputTokens;
          expectedDurationMs += durationMs;

          const totals = getTaskLifetimeTotals(taskId);
          expect(totals.attemptsCount).toBe(expectedAttempts);
          expect(totals.tokenCount).toBe(expectedTokenCount);
          expect(totals.inputTokens).toBe(expectedInputTokens);
          expect(totals.outputTokens).toBe(expectedOutputTokens);
          expect(totals.durationMs).toBe(expectedDurationMs);

          if (previousTotals) {
            expect(totals.attemptsCount).toBeGreaterThanOrEqual(previousTotals.attemptsCount);
            expect(totals.tokenCount).toBeGreaterThanOrEqual(previousTotals.tokenCount);
            expect(totals.durationMs).toBeGreaterThanOrEqual(previousTotals.durationMs);
          }
          previousTotals = totals;
        }
      }

      _resetRuntimeAccumulatorForTests({ cacheDir });
      const restoredTotals = getTaskLifetimeTotals(taskId);
      expect(restoredTotals.attemptsCount).toBe(6);
      expect(restoredTotals.tokenCount).toBe(expectedTokenCount);
      expect(restoredTotals.inputTokens).toBe(expectedInputTokens);
      expect(restoredTotals.outputTokens).toBe(expectedOutputTokens);
      expect(restoredTotals.durationMs).toBe(expectedDurationMs);

      const runtimeStats = getRuntimeStats();
      expect(runtimeStats.sessionCount).toBe(6);
      expect(runtimeStats.runtimeMs).toBe(expectedDurationMs);

      const logPath = getSessionAccumulatorLogPath();
      const lines = readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      expect(lines).toHaveLength(6);
    } finally {
      _resetRuntimeAccumulatorForTests();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
