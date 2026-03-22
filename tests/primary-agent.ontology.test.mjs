import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("primary agent ontology prompt grounding", () => {
  it("injects local ontology packs into the primary tool capability contract", () => {
    const source = readFileSync(resolve(process.cwd(), "agent/primary-agent.mjs"), "utf8");
    expect(source).toContain('loadLocalCapabilityOntologyPacks');
    expect(source).toContain('ontologyPacks: resolvedOntologyPacks');
    expect(source).toContain('const ontologyBlock = formatCapabilityOntologyPacks(resolvedOntologyPacks);');
    expect(source).toContain('ontologyBlock,');
  });
});
