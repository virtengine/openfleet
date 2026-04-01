import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildConfigEditorModel,
  findConfigValidationMessage,
  parseConfigEditorInput,
  validateConfigDocument,
} from "../config/config-editor.mjs";

const schema = JSON.parse(
  readFileSync(new URL("../bosun.schema.json", import.meta.url), "utf8"),
);

describe("config editor helpers", () => {
  it("builds grouped config fields with env override metadata", () => {
    const envOverridesByPath = new Map([
      ["kanban.backend", { envKey: "KANBAN_BACKEND", value: "jira" }],
      ["voice.openaiApiKey", { envKey: "OPENAI_API_KEY", value: "top-secret" }],
    ]);

    const model = buildConfigEditorModel({
      schema,
      configData: {
        projectName: "Bosun",
        kanban: { backend: "github" },
      },
      envOverridesByPath,
    });

    const kanbanField = model.fieldIndex.get("kanban.backend");
    const secretField = model.fieldIndex.get("voice.openaiApiKey");

    expect(kanbanField?.source).toBe("env");
    expect(kanbanField?.readOnly).toBe(true);
    expect(kanbanField?.valueText).toBe("jira");
    expect(secretField?.masked).toBe(true);
    expect(model.sections.find((section) => section.id === "kanban")?.items.length).toBeGreaterThan(0);
  });

  it("parses typed editor input and reports schema validation errors", () => {
    const numberSchema = modelFieldSchema("internalExecutor.maxParallel");
    const enumSchema = modelFieldSchema("kanban.backend");

    expect(parseConfigEditorInput(numberSchema, "5")).toBe(5);
    expect(parseConfigEditorInput(enumSchema, "github")).toBe("github");
    expect(() => parseConfigEditorInput(numberSchema, "oops")).toThrow("Expected number value");

    const invalidCandidate = {
      $schema: "./bosun.schema.json",
      kanban: { backend: "bogus" },
    };
    const errors = validateConfigDocument(schema, invalidCandidate);
    expect(errors.length).toBeGreaterThan(0);
    expect(findConfigValidationMessage(errors, ["kanban", "backend"])).toContain("allowed values");
  });
});

function modelFieldSchema(path) {
  const pathParts = String(path || "").split(".").filter(Boolean);
  let cursor = schema;
  for (const part of pathParts) {
    cursor = cursor?.properties?.[part];
  }
  return cursor;
}
