import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetMicTrackRegistryForTests,
  ensureMicTrackingPatched,
  registerMicStream,
  stopTrackedMicStreams,
} from "../ui/modules/mic-track-registry.js";

function makeTrack(kind = "audio") {
  const track = {
    kind,
    readyState: "live",
    addEventListener: vi.fn(),
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };
  return track;
}

function makeStream(tracks = []) {
  return {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks.filter((t) => String(t.kind).toLowerCase() === "audio")),
  };
}

describe("mic-track-registry", () => {
  beforeEach(() => {
    _resetMicTrackRegistryForTests();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
      },
    });
  });

  it("tracks getUserMedia streams and stops only audio tracks", async () => {
    const audio = makeTrack("audio");
    const video = makeTrack("video");
    const stream = makeStream([audio, video]);
    globalThis.navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);

    ensureMicTrackingPatched();
    const result = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    expect(result).toBe(stream);

    stopTrackedMicStreams();
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(video.stop).toHaveBeenCalledTimes(0);
  });

  it("supports manually registered streams", () => {
    const audio = makeTrack("audio");
    const stream = makeStream([audio]);
    registerMicStream(stream);

    stopTrackedMicStreams();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("is safe when mediaDevices/getUserMedia are unavailable", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {},
    });
    expect(() => ensureMicTrackingPatched()).not.toThrow();
    expect(() => stopTrackedMicStreams()).not.toThrow();
  });
});
