import { describe, expect, it } from "vitest";
import { createErrorDetector } from "../error-detector.mjs";

describe("error-detector enhanced methods", () => {
  describe("analyzeMessageSequence", () => {
    it("returns empty for no messages", () => {
      const detector = createErrorDetector();
      const result = detector.analyzeMessageSequence([]);
      expect(result.patterns).toEqual([]);
      expect(result.primary).toBeNull();
    });

    it("detects tool_loop pattern", () => {
      const detector = createErrorDetector();
      const messages = [];
      for (let i = 0; i < 6; i++) {
        messages.push({
          type: "tool_call",
          content: "read_file(/some/path)",
          meta: { toolName: "read_file" },
        });
      }

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("tool_loop");
      expect(result.details.tool_loop).toBeDefined();
    });

    it("detects analysis_paralysis (all reads, no writes)", () => {
      const detector = createErrorDetector();
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({
          type: "tool_call",
          content: i % 2 === 0 ? "read_file()" : "grep_search()",
          meta: { toolName: i % 2 === 0 ? "read_file" : "grep_search" },
        });
      }

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("analysis_paralysis");
    });

    it("does NOT detect analysis_paralysis when edits present", () => {
      const detector = createErrorDetector();
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({
          type: "tool_call",
          content: "read_file()",
          meta: { toolName: "read_file" },
        });
      }
      messages.push({
        type: "tool_call",
        content: "write_file()",
        meta: { toolName: "create_file" },
      });

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("analysis_paralysis");
    });

    it("detects plan_stuck pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        { type: "agent_message", content: "Here's the plan for this task..." },
        { type: "agent_message", content: "Ready to start implementing?" },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("plan_stuck");
    });

    it("detects needs_clarification pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "I need clarification on which approach to take",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("needs_clarification");
    });

    it("detects false_completion pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "Task complete! I've completed all the changes.",
        },
        {
          type: "tool_call",
          content: "read_file()",
          meta: { toolName: "read_file" },
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("false_completion");
    });

    it("does NOT detect false_completion when git commit is present", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "Task complete! I've completed all the changes.",
        },
        {
          type: "tool_call",
          content: "git commit -m 'fix: thing'",
          meta: { toolName: "run_in_terminal" },
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("false_completion");
    });

    it("detects rate_limited pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "error",
          content: "rate limit exceeded: 429 Too Many Requests",
        },
        {
          type: "error",
          content: "rate limit: please retry after 30s",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("rate_limited");
    });

    it("returns primary pattern by priority", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "error",
          content: "rate limit exceeded: 429",
        },
        {
          type: "error",
          content: "rate limit again: 429",
        },
        {
          type: "agent_message",
          content: "Here's the plan...",
        },
        {
          type: "agent_message",
          content: "Ready to start implementing?",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      // rate_limited has higher priority than plan_stuck
      expect(result.primary).toBe("rate_limited");
    });
  });

  describe("getRecoveryPromptForAnalysis", () => {
    it("returns plan_stuck recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Fix bug", {
        primary: "plan_stuck",
        details: {},
      });

      expect(prompt).toContain("CONTINUE IMPLEMENTATION");
      expect(prompt).toContain("Fix bug");
      expect(prompt).toContain("implement immediately");
    });

    it("returns tool_loop recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Build feature", {
        primary: "tool_loop",
        details: { tool_loop: "Repeated: read_file" },
      });

      expect(prompt).toContain("BREAK THE LOOP");
    });

    it("returns analysis_paralysis recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Refactor", {
        primary: "analysis_paralysis",
        details: {},
      });

      expect(prompt).toContain("START EDITING");
    });

    it("returns needs_clarification recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: "needs_clarification",
        details: {},
      });

      expect(prompt).toContain("MAKE A DECISION");
    });

    it("returns false_completion recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: "false_completion",
        details: {},
      });

      expect(prompt).toContain("ACTUALLY COMPLETE");
      expect(prompt).toContain("git commit");
    });

    it("returns rate_limited recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: "rate_limited",
        details: {},
      });

      expect(prompt).toContain("RATE LIMITED");
    });

    it("returns generic prompt for null analysis", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: null,
        details: {},
      });

      expect(prompt).toContain("Continue working");
    });
  });
});
