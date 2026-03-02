import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("library agent type + bosun tools regressions", () => {
  it("supports filtering agent library entries by explicit agentType", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain('const agentTypeRaw = String(url.searchParams.get("agentType") || "").trim().toLowerCase()');
    expect(source).toContain("entry?.agentType");
    expect(source).toContain('return String(entry?.agentType || "").trim().toLowerCase() === agentTypeRaw;');
  });

  it("keeps bosun runtime tool toggles independent from built-in defaults", () => {
    const source = readFileSync(resolve(process.cwd(), "agent-tool-config.mjs"), "utf8");
    expect(source).toContain("const explicitBuiltinEnabled = explicitEnabled");
    expect(source).toContain("const useBuiltinAllowlist = explicitBuiltinEnabled.length > 0;");
    expect(source).toContain("useBuiltinAllowlist");
  });

  it("renders agent type selector and bosun tools tab in library UI", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/tabs/library.js"), "utf8");
    expect(source).toContain("Agent Type");
    expect(source).toContain(":zap: Bosun");
    expect(source).toContain("toggleBosunTool");
  });
});
