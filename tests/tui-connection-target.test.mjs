import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  normalizeRemoteConnectionConfig,
  parseConnectionEndpoint,
  resolveLocalTuiConnectionTarget,
  resolveTuiConnectionTarget,
  saveRemoteConnectionConfig,
  testConnectionTarget,
  upsertRemoteConnection,
} from "../tui/lib/connection-target.mjs";

describe("tui connection target resolution", () => {
  it("parses explicit remote endpoints into websocket/http transport details", () => {
    expect(parseConnectionEndpoint("https://bosun.example.com:4400")).toEqual({
      endpoint: "https://bosun.example.com:4400",
      host: "bosun.example.com",
      port: 4400,
      protocol: "wss",
      httpProtocol: "https",
    });
  });

  it("normalizes legacy single-target config into the multi-connection shape", () => {
    expect(normalizeRemoteConnectionConfig({
      enabled: true,
      endpoint: "https://bosun.example.com:4400",
      apiKey: "legacy-key",
    })).toMatchObject({
      enabled: true,
      endpoint: "https://bosun.example.com:4400",
      apiKey: "legacy-key",
      activeConnectionId: "primary",
      connections: [
        {
          id: "primary",
          endpoint: "https://bosun.example.com:4400",
          apiKey: "legacy-key",
        },
      ],
    });
  });

  it("prefers a saved remote connection before local defaults", () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-tui-remote-"));
    try {
      saveRemoteConnectionConfig({
        enabled: true,
        endpoint: "https://saved.example.com:9443",
        apiKey: "secret-key",
      }, configDir);

      expect(resolveTuiConnectionTarget({
        configDir,
        env: {},
        config: {},
      })).toEqual({
        endpoint: "https://saved.example.com:9443",
        host: "saved.example.com",
        port: 9443,
        protocol: "wss",
        httpProtocol: "https",
        apiKey: "secret-key",
        source: "saved-remote",
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("upserts additional saved connections and keeps an active selection", () => {
    const next = upsertRemoteConnection({
      enabled: true,
      endpoint: "https://one.example.com:4400",
      apiKey: "one",
    }, {
      name: "Two",
      endpoint: "https://two.example.com:4400",
      apiKey: "two",
      enabled: true,
    });

    expect(next.connections).toHaveLength(2);
    expect(next.activeConnectionId).toBe("two");
    expect(next.endpoint).toBe("https://two.example.com:4400");
  });

  it("uses the persisted UI instance lock when no remote target is saved", () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-tui-lock-"));
    try {
      mkdirSync(join(configDir, ".cache"), { recursive: true });
      writeFileSync(
        join(configDir, ".cache", "ui-server.instance.lock.json"),
        JSON.stringify({ url: "https://127.0.0.1:4400" }),
        "utf8",
      );

      expect(resolveTuiConnectionTarget({
        configDir,
        env: {},
        config: {},
      })).toEqual({
        endpoint: "https://127.0.0.1:4400",
        host: "127.0.0.1",
        port: 4400,
        protocol: "wss",
        httpProtocol: "https",
        apiKey: "",
        source: "ui-instance-lock",
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("builds a local attach target from the UI instance lock", () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-tui-local-"));
    try {
      mkdirSync(join(configDir, ".cache"), { recursive: true });
      writeFileSync(
        join(configDir, ".cache", "ui-server.instance.lock.json"),
        JSON.stringify({ host: "192.168.0.10", port: 4400, protocol: "https" }),
        "utf8",
      );

      expect(resolveLocalTuiConnectionTarget({
        configDir,
        env: {},
        config: {},
      })).toEqual({
        endpoint: "https://192.168.0.10:4400",
        host: "192.168.0.10",
        port: 4400,
        protocol: "wss",
        httpProtocol: "https",
        apiKey: "",
        source: "ui-instance-lock",
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("tests a candidate endpoint before saving it", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/api/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      await expect(testConnectionTarget(`http://127.0.0.1:${port}`)).resolves.toMatchObject({
        ok: true,
        statusCode: 200,
        target: {
          endpoint: `http://127.0.0.1:${port}`,
          host: "127.0.0.1",
          port,
          protocol: "ws",
          httpProtocol: "http",
        },
      });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
