import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CHECKLIST_PATH = resolve(process.cwd(), "docs", "native-call-parity-checklist.md");

describe("native-call parity checklist", () => {
  it("documents OpenAI, Claude, and Gemini coverage", () => {
    const doc = readFileSync(CHECKLIST_PATH, "utf8");
    expect(doc).toContain("OpenAI");
    expect(doc).toContain("Claude");
    expect(doc).toContain("Gemini");
  });

  it("contains required parity criteria IDs and automation links", () => {
    const doc = readFileSync(CHECKLIST_PATH, "utf8");
    for (const id of [
      "PARITY-001",
      "PARITY-002",
      "PARITY-003",
      "PARITY-004",
      "PARITY-005",
    ]) {
      expect(doc).toContain(id);
    }
    expect(doc).toContain("tests/voice-provider-smoke.test.mjs");
    expect(doc).toContain("npm run check:native-call-parity");
    expect(doc).toContain(".github/workflows/ci.yaml");
  });
});
