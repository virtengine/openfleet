import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, extname, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const SITE_ROOT = resolve(process.cwd(), "site");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(pathname) {
  return MIME_TYPES[extname(pathname).toLowerCase()] || "application/octet-stream";
}

function toFsPath(urlPath) {
  const cleaned = decodeURIComponent((urlPath || "/").split("?")[0].split("#")[0]);
  const requested = cleaned === "/" ? "/indexv2.html" : cleaned;
  const candidate = normalize(resolve(SITE_ROOT, `.${requested}`));
  if (!candidate.startsWith(SITE_ROOT)) return null;
  return candidate;
}

function extractLocalAssets(html, htmlPath) {
  const assets = new Set();
  const dir = htmlPath.split("/").slice(0, -1).join("/");

  const collect = (re) => {
    let match;
    while ((match = re.exec(html)) !== null) {
      const value = (match[1] || "").trim();
      if (!value) continue;
      if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:") || value.startsWith("#")) continue;
      if (value.startsWith("//")) continue;
      if (value.startsWith("/")) {
        assets.add(value);
      } else {
        const base = dir || "";
        assets.add(`/${base ? `${base}/` : ""}${value}`.replace(/\/+/g, "/"));
      }
    }
  };

  collect(/<script[^>]+src=["']([^"']+)["']/gi);
  collect(/<link[^>]+href=["']([^"']+)["']/gi);
  return [...assets];
}

function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || "";
    const body = (match[2] || "").trim();
    if (attrs.includes("src=")) continue;
    const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
    const scriptType = (typeMatch?.[1] || "").toLowerCase();
    const isModule = scriptType === "module";
    const isJsType =
      scriptType === "" ||
      scriptType === "text/javascript" ||
      scriptType === "application/javascript" ||
      scriptType === "module";
    if (!isJsType) continue;
    if (!body) continue;
    scripts.push({ code: body, isModule });
  }
  return scripts;
}

function extractModuleScriptSrc(html, htmlPath) {
  const srcs = [];
  const dir = htmlPath.split("/").slice(0, -1).join("/");
  const re = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const value = (match[1] || "").trim();
    if (!value || value.startsWith("http") || value.startsWith("//") || value.startsWith("data:")) continue;
    if (value.startsWith("/")) srcs.push(value);
    else srcs.push(`/${dir ? `${dir}/` : ""}${value}`.replace(/\/+/g, "/"));
  }
  return srcs;
}

function listStaticImports(source) {
  const imports = [];
  const re = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    imports.push({ clause: match[1].trim(), specifier: match[2].trim() });
  }
  return imports;
}

function parseImportClause(clause) {
  const result = { hasDefault: false, hasNamespace: false, named: [] };
  if (!clause) return result;

  let remaining = clause;

  if (remaining.startsWith("*")) {
    result.hasNamespace = true;
    return result;
  }

  const braceIdx = remaining.indexOf("{");
  if (braceIdx >= 0) {
    const head = remaining.slice(0, braceIdx).trim().replace(/,$/, "").trim();
    if (head) result.hasDefault = true;
    const namedBlock = remaining.slice(braceIdx).match(/\{([\s\S]*?)\}/)?.[1] || "";
    for (const raw of namedBlock.split(",")) {
      const token = raw.trim();
      if (!token) continue;
      const imported = token.split(/\s+as\s+/i)[0].trim();
      if (imported) result.named.push(imported);
    }
    return result;
  }

  if (remaining.includes(",") && remaining.includes("*")) {
    result.hasDefault = true;
    result.hasNamespace = true;
    return result;
  }

  result.hasDefault = Boolean(remaining.trim());
  return result;
}

function parseExports(source) {
  const exported = new Set();
  let hasDefault = false;

  const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  const classRe = /export\s+class\s+([A-Za-z_$][\w$]*)/g;
  const varRe = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const listRe = /export\s*\{([\s\S]*?)\}/g;

  let match;
  while ((match = fnRe.exec(source)) !== null) exported.add(match[1]);
  while ((match = classRe.exec(source)) !== null) exported.add(match[1]);
  while ((match = varRe.exec(source)) !== null) exported.add(match[1]);
  while ((match = listRe.exec(source)) !== null) {
    for (const raw of match[1].split(",")) {
      const token = raw.trim();
      if (!token) continue;
      const asSplit = token.split(/\s+as\s+/i);
      const name = (asSplit[1] || asSplit[0]).trim();
      if (name) exported.add(name);
    }
  }

  if (/export\s+default\s+/m.test(source)) hasDefault = true;
  return { exported, hasDefault };
}

function resolveImportPath(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(fromFile, "..");
  const direct = resolve(base, specifier);
  const candidates = [direct, `${direct}.js`, `${direct}.mjs`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function createMockElement(id, demoName) {
  const listeners = new Map();
  const classSet = new Set();
  const classList = {
    add: (...names) => names.forEach((n) => classSet.add(n)),
    remove: (...names) => names.forEach((n) => classSet.delete(n)),
    contains: (name) => classSet.has(name),
    toggle: (name, force) => {
      if (force === true) {
        classSet.add(name);
        return true;
      }
      if (force === false) {
        classSet.delete(name);
        return false;
      }
      if (classSet.has(name)) {
        classSet.delete(name);
        return false;
      }
      classSet.add(name);
      return true;
    },
  };

  return {
    id,
    dataset: demoName ? { demo: demoName } : {},
    classList,
    style: {},
    textContent: "",
    setAttribute() {},
    getAttribute() { return null; },
    closest() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, handler) {
      const arr = listeners.get(type) || [];
      arr.push(handler);
      listeners.set(type, arr);
    },
    click() {
      const arr = listeners.get("click") || [];
      for (const handler of arr) handler({ preventDefault() {} });
    },
  };
}

async function parseAsModule(code, label) {
  if (typeof vm.SourceTextModule !== "function") {
    expect(code.length).toBeGreaterThan(0);
    return;
  }
  const mod = new vm.SourceTextModule(code, { identifier: label });
  await mod.link(async () => new vm.SourceTextModule("export default {}"));
}

describe("demo load smoke", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    if (!existsSync(SITE_ROOT)) {
      throw new Error(`site directory not found: ${SITE_ROOT}`);
    }

    server = createServer((req, res) => {
      const fsPath = toFsPath(req.url || "/");
      if (!fsPath) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      try {
        const body = readFileSync(fsPath);
        res.writeHead(200, { "Content-Type": contentTypeFor(fsPath) });
        res.end(body);
      } catch {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });

    await new Promise((resolvePromise, rejectPromise) => {
      server.listen(0, "127.0.0.1", () => resolvePromise());
      server.once("error", rejectPromise);
    });

    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    if (!server) return;
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("serves the landing page and demo page", async () => {
    const [landing, demo] = await Promise.all([
      fetch(`${baseUrl}/indexv2.html`),
      fetch(`${baseUrl}/ui/demo.html`),
    ]);

    expect(landing.status).toBe(200);
    expect(demo.status).toBe(200);

    const [landingHtml, demoHtml] = await Promise.all([landing.text(), demo.text()]);

    expect(landingHtml).toContain('id="demo-panel-desktop"');
    expect(landingHtml).toContain('src="ui/demo.html"');
    expect(demoHtml).toContain('id="app"');
    expect(demoHtml).toContain('type="module" src="app.js"');
  });

  it("serves all local assets required by landing and demo entrypoints", async () => {
    const landingHtml = await fetch(`${baseUrl}/indexv2.html`).then((r) => r.text());
    const demoHtml = await fetch(`${baseUrl}/ui/demo.html`).then((r) => r.text());

    const assets = [
      ...extractLocalAssets(landingHtml, "indexv2.html"),
      ...extractLocalAssets(demoHtml, "ui/demo.html"),
    ];

    const uniqueAssets = [...new Set(assets)];
    expect(uniqueAssets.length).toBeGreaterThan(10);

    const failures = [];
    await Promise.all(
      uniqueAssets.map(async (assetPath) => {
        const res = await fetch(`${baseUrl}${assetPath}`);
        if (!res.ok) {
          failures.push(`${assetPath} => ${res.status}`);
        }
      }),
    );

    if (failures.length > 0) {
      expect.fail(`Missing/failed local assets:\n${failures.join("\n")}`);
    }
  });

  it("has syntactically valid inline scripts and entry modules", async () => {
    const landingHtml = await fetch(`${baseUrl}/indexv2.html`).then((r) => r.text());
    const demoHtml = await fetch(`${baseUrl}/ui/demo.html`).then((r) => r.text());

    const inlineChecks = [
      ...extractInlineScripts(landingHtml).map((s, idx) => ({ ...s, label: `indexv2:inline:${idx}` })),
      ...extractInlineScripts(demoHtml).map((s, idx) => ({ ...s, label: `demo:inline:${idx}` })),
    ];

    for (const script of inlineChecks) {
      if (script.isModule) {
        await parseAsModule(script.code, script.label);
      } else {
        expect(() => new vm.Script(script.code, { filename: script.label })).not.toThrow();
      }
    }

    const moduleSrcs = [
      ...extractModuleScriptSrc(landingHtml, "indexv2.html"),
      ...extractModuleScriptSrc(demoHtml, "ui/demo.html"),
    ];

    for (const srcPath of moduleSrcs) {
      const code = await fetch(`${baseUrl}${srcPath}`).then(async (res) => {
        expect(res.ok).toBe(true);
        return res.text();
      });
      await parseAsModule(code, `module:${srcPath}`);
    }
  });

  it("miniapp local module graph has valid imports/exports and syntax", () => {
    const entry = resolve(SITE_ROOT, "ui/app.js");
    const queue = [entry];
    const visited = new Set();
    const importErrors = [];
    const syntaxErrors = [];

    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || visited.has(file)) continue;
      visited.add(file);

      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (check.status !== 0) {
        syntaxErrors.push(`${file}: ${(check.stderr || check.stdout || "syntax check failed").trim()}`);
      }

      const source = readFileSync(file, "utf8");
      const imports = listStaticImports(source);

      for (const imp of imports) {
        const target = resolveImportPath(file, imp.specifier);
        if (!imp.specifier.startsWith(".")) continue;
        if (!target) {
          importErrors.push(`${file} -> ${imp.specifier}: target not found`);
          continue;
        }
        queue.push(target);

        const parsed = parseImportClause(imp.clause);
        if (parsed.named.length === 0 && !parsed.hasDefault) continue;

        const targetSource = readFileSync(target, "utf8");
        const exportsInfo = parseExports(targetSource);

        if (parsed.hasDefault && !exportsInfo.hasDefault) {
          importErrors.push(`${file} -> ${imp.specifier}: missing default export in ${target}`);
        }
        for (const named of parsed.named) {
          if (!exportsInfo.exported.has(named)) {
            importErrors.push(`${file} -> ${imp.specifier}: missing named export \"${named}\" in ${target}`);
          }
        }
      }
    }

    if (syntaxErrors.length > 0) {
      expect.fail(`MiniApp module syntax errors:\n${syntaxErrors.join("\n\n")}`);
    }
    if (importErrors.length > 0) {
      expect.fail(`MiniApp import/export linkage errors:\n${importErrors.join("\n")}`);
    }
    expect(visited.size).toBeGreaterThan(15);
  }, 30000);

  it("landing demo tabs activate and lazy initializers run", () => {
    const scriptPath = resolve(SITE_ROOT, "js/main.js");
    const mainJs = readFileSync(scriptPath, "utf8");

    const desktopTab = createMockElement("tab-desktop", "desktop");
    const cliTab = createMockElement("tab-cli", "cli");
    const telegramTab = createMockElement("tab-telegram", "telegram");
    const mobileTab = createMockElement("tab-mobile", "mobile");
    const tabs = [desktopTab, cliTab, telegramTab, mobileTab];

    const panelDesktop = createMockElement("demo-panel-desktop");
    const panelCli = createMockElement("demo-panel-cli");
    const panelTelegram = createMockElement("demo-panel-telegram");
    const panelMobile = createMockElement("demo-panel-mobile");
    const terminalBody = createMockElement("terminal-window-body");
    const panels = [panelDesktop, panelCli, panelTelegram, panelMobile];
    const panelsById = new Map(panels.map((p) => [p.id, p]));

    let terminalInitCalls = 0;
    let telegramInitCalls = 0;

    const documentMock = {
      documentElement: { scrollHeight: 1000 },
      body: { classList: createMockElement("body").classList },
      getElementById(id) {
        return panelsById.get(id) || null;
      },
      querySelector(selector) {
        if (selector === ".demo-tab[data-demo=\"desktop\"]") return desktopTab;
        if (selector === ".demo-tab[data-demo=\"cli\"]") return cliTab;
        if (selector === ".demo-tab[data-demo=\"telegram\"]") return telegramTab;
        if (selector === ".demo-tab[data-demo=\"mobile\"]") return mobileTab;
        if (selector === ".terminal-window__body") return terminalBody;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === ".demo-tab") return tabs;
        if (selector === ".demo-panel") return panels;
        return [];
      },
      addEventListener() {},
    };

    const context = {
      window: {
        innerWidth: 1280,
        innerHeight: 900,
        scrollY: 0,
        addEventListener() {},
        bosunTrack() {},
        initBosunTerminal() { terminalInitCalls += 1; },
        initTelegramChatDemo() { telegramInitCalls += 1; },
      },
      document: documentMock,
      navigator: { clipboard: { writeText: async () => {} } },
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
      },
      setTimeout() { return 0; },
      setInterval() { return 0; },
      clearInterval() {},
      clearTimeout() {},
      fetch: async () => ({ ok: true, json: async () => ({ version: "0.0.0" }) }),
      console,
    };
    const jqueryMock = (selector) => ({ length: selector === "#terminal-window" ? 1 : 0 });
    jqueryMock.fn = { terminal: true };
    context.$ = jqueryMock;
    context.window.document = documentMock;

    expect(() => vm.runInNewContext(mainJs, context, { filename: "site/js/main.js" })).not.toThrow();

    expect(desktopTab.classList.contains("demo-tab--active")).toBe(true);
    expect(panelDesktop.classList.contains("demo-panel--active")).toBe(true);

    cliTab.click();
    expect(cliTab.classList.contains("demo-tab--active")).toBe(true);
    expect(panelCli.classList.contains("demo-panel--active")).toBe(true);
    expect(terminalInitCalls).toBe(1);

    telegramTab.click();
    expect(telegramTab.classList.contains("demo-tab--active")).toBe(true);
    expect(panelTelegram.classList.contains("demo-panel--active")).toBe(true);
    expect(telegramInitCalls).toBe(1);
  });
});
