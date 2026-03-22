import { describe, expect, it } from "vitest";

import { buildSessionCommand } from "../tui/screens/agents-helpers.mjs";

describe("tui agents screen action payloads", () => {
  it("builds logs, pause, resume, diff, and kill commands from the selected session", () => {
    const session = {
      id: "MT-735-abcdef",
      sessionId: "session-735",
      pid: 654,
      turn: 1,
    };

    expect(buildSessionCommand("logs", session)).toEqual({
      type: "session:logs",
      payload: { id: "MT-735-abcdef", pid: 654, sessionId: "session-735", turn: 1 },
    });
    expect(buildSessionCommand("pause", session)).toEqual({
      type: "session:pause",
      payload: { id: "MT-735-abcdef", pid: 654, sessionId: "session-735", turn: 1 },
    });
    expect(buildSessionCommand("resume", session)).toEqual({
      type: "session:resume",
      payload: { id: "MT-735-abcdef", pid: 654, sessionId: "session-735", turn: 1 },
    });
    expect(buildSessionCommand("diff", session)).toEqual({
      type: "session:diff",
      payload: { id: "MT-735-abcdef", pid: 654, sessionId: "session-735", turn: 1 },
    });
    expect(buildSessionCommand("kill", session)).toEqual({
      type: "session:kill",
      payload: { id: "MT-735-abcdef", pid: 654, sessionId: "session-735", turn: 1 },
    });
  });

  it("builds detail commands using the same selected session payload shape", () => {
    const session = {
      id: "MT-734-abcdef",
      sessionId: "session-734",
      processId: 321,
      latestTurn: 4,
    };

    expect(buildSessionCommand("detail", session)).toEqual({
      type: "session:detail",
      payload: { id: "MT-734-abcdef", pid: 321, sessionId: "session-734", turn: 4 },
    });
  });

  it("builds copy commands using the same selected session payload shape", () => {
    const session = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-999",
      pid: 777,
      turn: 9,
    };

    expect(buildSessionCommand("copy", session)).toEqual({
      type: "session:copy",
      payload: {
        id: "123e4567-e89b-12d3-a456-426614174000",
        pid: 777,
        sessionId: "session-999",
        turn: 9,
      },
    });
  });
});

