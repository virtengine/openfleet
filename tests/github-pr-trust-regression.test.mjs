import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("GitHub PR trust regressions", () => {
  it("classifies attach policy separately from repair automation", () => {
    const attachWorkflow = read(".github/workflows/bosun-pr-attach.yml");
    const ciSignalWorkflow = read(".github/workflows/bosun-pr-ci-signal.yml");

    expect(attachWorkflow).toContain("const classLabels = {");
    expect(attachWorkflow).toContain("const attachMode = [\"all\", \"trusted-only\", \"disabled\"].includes(attachModeRaw)");
    expect(attachWorkflow).toContain("const shouldAttach = isBosunCreated || attachMode === \"all\" || (attachMode === \"trusted-only\" && isTrustedAuthor);");
    expect(attachWorkflow).toContain("bosun-pr-bosun-created");
    expect(attachWorkflow).toContain("bosun-pr-trusted-author");
    expect(attachWorkflow).toContain("bosun-pr-public");
    expect(attachWorkflow).toContain("Bosun PR classification:");

    expect(ciSignalWorkflow).toContain("const createdMarker = \"<!-- bosun-created -->\";");
    expect(ciSignalWorkflow).toContain("const trustedAuthors = new Set(normalizeList(prAutomation.trustedAuthors));");
    expect(ciSignalWorkflow).toContain("const canSignalFix = isBosunCreated || (allowTrustedFixes && isTrustedAuthor);");
    expect(ciSignalWorkflow).toContain("const isBosunCreated =");
    expect(ciSignalWorkflow).toContain("attached but not Bosun-created or trusted for repair; skipping high-risk CI signaling");
    expect(ciSignalWorkflow).toContain("trusted-author PR");
  });

  it("documents operator PR automation trust settings", () => {
    const schema = read("bosun.schema.json");
    const example = read("bosun.config.example.json");
    const configSource = read("config/config.mjs");
    const serverSource = read("server/ui-server.mjs");
    const settingsSource = read("ui/tabs/settings.js");
    const siteSettingsSource = read("site/ui/tabs/settings.js");

    expect(schema).toContain('"prAutomation"');
    expect(schema).toContain('"trustedAuthors"');
    expect(schema).toContain('"allowTrustedFixes"');
    expect(schema).toContain('"allowTrustedMerges"');
    expect(schema).toContain('"assistiveActions"');
    expect(schema).toContain('"installOnSetup"');

    expect(example).toContain('"prAutomation"');
    expect(example).toContain('"trustedAuthors"');
    expect(example).toContain('"allowTrustedFixes"');
    expect(example).toContain('"allowTrustedMerges"');
    expect(example).toContain('"assistiveActions"');
    expect(example).toContain('"installOnSetup"');

    expect(configSource).toContain("const prAutomation = Object.freeze({");
    expect(configSource).toContain("BOSUN_PR_TRUSTED_AUTHORS");
    expect(configSource).toContain("BOSUN_PR_ALLOW_TRUSTED_FIXES");
    expect(configSource).toContain("BOSUN_PR_ALLOW_TRUSTED_MERGES");
    expect(configSource).toContain("BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP");

    expect(serverSource).toContain('if (path === "/api/pr-automation" && req.method === "GET")');
    expect(serverSource).toContain('if (path === "/api/pr-automation" && req.method === "POST")');
    expect(serverSource).toContain("normalizePrAutomationPolicy(configData?.prAutomation)");
    expect(serverSource).toContain("assistiveActions");

    for (const source of [settingsSource, siteSettingsSource]) {
      expect(source).toContain("PR Automation Trust Policy");
      expect(source).toContain('settings-pr-automation');
      expect(source).toContain('/api/pr-automation');
      expect(source).toContain("Install optional repo-local GitHub Actions during setup");
    }
  });
});