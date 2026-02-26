import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { getKanbanAdapter, setKanbanBackend } from "../kanban-adapter.mjs";

const ENV_KEYS = [
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "BOSUN_CONFIG_PATH",
  "BOSUN_TRIGGER_TEMPLATE_STATS_TIMEOUT_MS",
  "KANBAN_BACKEND",
];

let envSnapshot = {};
let tmpRoot = "";
let configPath = "";
let uiModule = null;
let server = null;

async function writeTriggerConfig(filePath) {
  const doc = {
    $schema: "./bosun.schema.json",
    triggerSystem: {
      enabled: true,
      defaults: { executor: "auto", model: "auto" },
      templates: [
        {
          id: "task-planner",
          name: "Task Planner",
          enabled: true,
          action: "task-planner",
          trigger: {
            anyOf: [{ kind: "metric", metric: "backlogRemaining", operator: "eq", value: 0 }],
          },
          config: { plannerMode: "kanban", defaultTaskCount: 5 },
        },
      ],
    },
  };
  await writeFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

async function startServer() {
  if (!uiModule) {
    uiModule = await import("../ui-server.mjs");
  }
  server = await uiModule.startTelegramUiServer({
    port: 0,
    host: "127.0.0.1",
    dependencies: {},
  });
  return server;
}

function getTemplateById(payload, templateId) {
  const list = Array.isArray(payload?.data?.templates) ? payload.data.templates : [];
  return list.find((item) => String(item?.id || "").toLowerCase() === templateId);
}

describe("trigger template stats timeout handling", () => {
  beforeEach(async () => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.BOSUN_TRIGGER_TEMPLATE_STATS_TIMEOUT_MS = "25";
    process.env.KANBAN_BACKEND = "internal";

    tmpRoot = await mkdtemp(resolve(tmpdir(), "bosun-ui-timeout-"));
    configPath = resolve(tmpRoot, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    await writeTriggerConfig(configPath);

    setKanbanBackend("internal");
  });

  afterEach(async () => {
    if (uiModule?.stopTelegramUiServer) {
      uiModule.stopTelegramUiServer();
    }
    server = null;

    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }

    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    tmpRoot = "";
    configPath = "";
  });

  it("returns template payload when listProjects exceeds timeout", async () => {
    const adapter = getKanbanAdapter();
    adapter.listProjects = () => new Promise(() => {});
    adapter.listTasks = async () => {
      throw new Error("listTasks should not run when listProjects times out");
    };

    const srv = await startServer();
    const port = srv.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);

    assert.equal(response.status, 200);

    const json = await response.json();
    assert.equal(json.ok, true);
    const template = getTemplateById(json, "task-planner");
    assert.ok(template, "expected task-planner template in response");

    const stats = template.stats;
    assert.equal(stats.spawnedTotal, 0);
    assert.equal(stats.activeCount, 0);
    assert.equal(stats.doneCount, 0);
    assert.deepEqual(stats.runningAgents, []);
    assert.deepEqual(stats.recentSpawned, []);
  });

  it("returns template payload when listTasks exceeds timeout", async () => {
    const adapter = getKanbanAdapter();
    adapter.listProjects = async () => [{ id: "proj-1", name: "Project" }];
    adapter.listTasks = () => new Promise(() => {});

    const srv = await startServer();
    const port = srv.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);

    assert.equal(response.status, 200);

    const json = await response.json();
    assert.equal(json.ok, true);
    const template = getTemplateById(json, "task-planner");
    assert.ok(template, "expected task-planner template in response");

    const stats = template.stats;
    assert.equal(stats.spawnedTotal, 0);
    assert.equal(stats.activeCount, 0);
    assert.equal(stats.doneCount, 0);
    assert.deepEqual(stats.runningAgents, []);
    assert.deepEqual(stats.recentSpawned, []);
  });

  it("logs warning and returns template payload when listProjects throws", async () => {
    const adapter = getKanbanAdapter();
    adapter.listProjects = async () => {
      throw new Error("project lookup failed");
    };
    adapter.listTasks = async () => {
      throw new Error("listTasks should not run when listProjects fails");
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const srv = await startServer();
      const port = srv.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);

      assert.equal(response.status, 200);

      const json = await response.json();
      assert.equal(json.ok, true);
      const template = getTemplateById(json, "task-planner");
      assert.ok(template, "expected task-planner template in response");

      const stats = template.stats;
      assert.equal(stats.spawnedTotal, 0);
      assert.equal(stats.activeCount, 0);
      assert.equal(stats.doneCount, 0);
      assert.deepEqual(stats.runningAgents, []);
      assert.deepEqual(stats.recentSpawned, []);
      assert.equal(
        warnings.some((line) => line.includes("trigger template stats unavailable")),
        true,
      );
      assert.equal(warnings.some((line) => line.includes("project lookup failed")), true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("logs warning and returns template payload when listTasks throws", async () => {
    const adapter = getKanbanAdapter();
    adapter.listProjects = async () => [{ id: "proj-1", name: "Project" }];
    adapter.listTasks = async () => {
      throw new Error("project listing failed");
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const srv = await startServer();
      const port = srv.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);

      assert.equal(response.status, 200);

      const json = await response.json();
      assert.equal(json.ok, true);
      const template = getTemplateById(json, "task-planner");
      assert.ok(template, "expected task-planner template in response");

      const stats = template.stats;
      assert.equal(stats.spawnedTotal, 0);
      assert.equal(stats.activeCount, 0);
      assert.equal(stats.doneCount, 0);
      assert.deepEqual(stats.runningAgents, []);
      assert.deepEqual(stats.recentSpawned, []);
      assert.equal(
        warnings.some((line) => line.includes("trigger template stats unavailable")),
        true,
      );
      assert.equal(
        warnings.some((line) => line.includes("project listing failed")),
        true,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
  it("counts trigger-spawned tasks when kanban responses are quick", async () => {
    const adapter = getKanbanAdapter();
    adapter.listProjects = async () => [{ id: "proj-1", name: "Project" }];
    adapter.listTasks = async () => [
      {
        id: "task-1",
        title: "Generated task",
        status: "todo",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          triggerTemplate: { id: "task-planner", createdAt: "2026-01-01T00:00:00.000Z" },
          execution: { sdk: "codex", model: "gpt-5" },
        },
      },
    ];

    const srv = await startServer();
    const port = srv.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.ok, true);
    const template = getTemplateById(json, "task-planner");
    assert.ok(template, "expected task-planner template in response");

    const stats = template.stats;
    assert.equal(stats.spawnedTotal, 1);
    assert.equal(stats.activeCount, 1);
    assert.equal(stats.doneCount, 0);
    assert.equal(stats.recentSpawned.length, 1);
    assert.equal(stats.recentSpawned[0].id, "task-1");
  });
});
