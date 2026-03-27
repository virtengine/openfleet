import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveTaskAttachmentsStorePath,
  configureTaskAttachmentsStore,
  loadStore,
  mergeTaskAttachments,
  listTaskAttachments,
  addTaskAttachment,
} from "../task/task-attachments.mjs";

let tmpDir;

function fresh() {
  tmpDir = mkdtempSync(join(tmpdir(), "task-attach-test-"));
  configureTaskAttachmentsStore({
    storePath: "task-attachments.json",
    baseDir: tmpDir,
  });
  return tmpDir;
}

function cleanup() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── resolveTaskAttachmentsStorePath ─────────────────────────────────────

describe("resolveTaskAttachmentsStorePath", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("returns default path when no options provided", () => {
    const result = resolveTaskAttachmentsStorePath();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // After configureTaskAttachmentsStore the default should be the configured path
    expect(result).toContain("task-attachments.json");
  });

  it("returns custom path when storePath option is set", () => {
    const result = resolveTaskAttachmentsStorePath({
      storePath: "custom-attachments.json",
    });
    expect(result).toContain("custom-attachments.json");
  });

  it("resolves relative to baseDir when both storePath and baseDir provided", () => {
    const base = join(tmpDir, "nested");
    const result = resolveTaskAttachmentsStorePath({
      storePath: "my-store.json",
      baseDir: base,
    });
    expect(result).toBe(join(base, "my-store.json"));
  });
});

// ── configureTaskAttachmentsStore ───────────────────────────────────────

describe("configureTaskAttachmentsStore", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("changes store path and returns new path", () => {
    const newPath = configureTaskAttachmentsStore({
      storePath: "new-store.json",
      baseDir: tmpDir,
    });
    expect(newPath).toBe(join(tmpDir, "new-store.json"));
  });

  it("resets internal state when path changes", () => {
    // Load store to prime internal cache
    loadStore();

    // Write a file at a new path with different content
    const altDir = mkdtempSync(join(tmpdir(), "task-attach-alt-"));
    const altFile = join(altDir, "alt.json");
    const custom = {
      _meta: { version: 1, updatedAt: new Date().toISOString() },
      tasks: {
        "internal:RESET-1": {
          taskId: "RESET-1",
          backend: "internal",
          attachments: [{ url: "https://reset.test/file.txt" }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(altFile, JSON.stringify(custom), "utf8");

    // Reconfigure to the alt path — should clear _store/_loaded
    configureTaskAttachmentsStore({ storePath: "alt.json", baseDir: altDir });
    const store = loadStore();
    expect(store.tasks["internal:RESET-1"]).toBeDefined();
    expect(store.tasks["internal:RESET-1"].taskId).toBe("RESET-1");

    try {
      rmSync(altDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });
});

// ── loadStore ───────────────────────────────────────────────────────────

describe("loadStore", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("returns default store shape when no file exists", () => {
    const store = loadStore();
    expect(store).toBeDefined();
    expect(store).toHaveProperty("_meta");
    expect(store).toHaveProperty("tasks");
    expect(typeof store.tasks).toBe("object");
  });

  it("default store has _meta with version 1 and tasks object", () => {
    const store = loadStore();
    expect(store._meta.version).toBe(1);
    expect(store._meta).toHaveProperty("updatedAt");
    expect(typeof store._meta.updatedAt).toBe("string");
    expect(store.tasks).toEqual({});
  });

  it("reads existing store from disk", () => {
    const filePath = join(tmpDir, "task-attachments.json");
    const payload = {
      _meta: { version: 1, updatedAt: new Date().toISOString() },
      tasks: {
        "internal:TSK-42": {
          taskId: "TSK-42",
          backend: "internal",
          attachments: [{ url: "https://example.com/a.png" }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(payload), "utf8");

    // Reconfigure to force reload
    configureTaskAttachmentsStore({
      storePath: "task-attachments.json",
      baseDir: tmpDir,
    });
    const store = loadStore();
    expect(store.tasks).toHaveProperty("internal:TSK-42");
    expect(store.tasks["internal:TSK-42"].attachments).toHaveLength(1);
    expect(store.tasks["internal:TSK-42"].attachments[0].url).toBe(
      "https://example.com/a.png",
    );
  });

  it("handles corrupt JSON gracefully (returns default)", () => {
    const filePath = join(tmpDir, "task-attachments.json");
    writeFileSync(filePath, "{{NOT VALID JSON!!!}}", "utf8");

    configureTaskAttachmentsStore({
      storePath: "task-attachments.json",
      baseDir: tmpDir,
    });
    const store = loadStore();
    expect(store).toBeDefined();
    expect(store._meta.version).toBe(1);
    expect(store.tasks).toEqual({});
  });
});

// ── mergeTaskAttachments ────────────────────────────────────────────────

describe("mergeTaskAttachments", () => {
  it("returns empty array for two empty arrays", () => {
    expect(mergeTaskAttachments([], [])).toEqual([]);
  });

  it("returns all items from primary when secondary is empty", () => {
    const a = [{ url: "https://a.test/1.txt" }];
    const result = mergeTaskAttachments(a, []);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://a.test/1.txt");
  });

  it("returns all items from secondary when primary is empty", () => {
    const b = [{ url: "https://b.test/2.txt" }];
    const result = mergeTaskAttachments([], b);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://b.test/2.txt");
  });

  it("deduplicates attachments with same canonical key", () => {
    const a = [{ url: "https://dup.test/file.txt" }];
    const b = [{ url: "https://dup.test/file.txt" }];
    const result = mergeTaskAttachments(a, b);
    expect(result).toHaveLength(1);
  });

  it("primary takes precedence over secondary for duplicates", () => {
    const primary = [{ url: "https://dup.test/file.txt", label: "primary" }];
    const secondary = [{ url: "https://dup.test/file.txt", label: "secondary" }];
    const result = mergeTaskAttachments(primary, secondary);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("primary");
  });

  it("handles non-array inputs gracefully (null, undefined)", () => {
    expect(mergeTaskAttachments(null, undefined)).toEqual([]);
    expect(mergeTaskAttachments(null, [{ url: "https://a.test/x.txt" }])).toHaveLength(1);
    expect(mergeTaskAttachments([{ url: "https://a.test/y.txt" }], null)).toHaveLength(1);
  });
});

// ── listTaskAttachments ─────────────────────────────────────────────────

describe("listTaskAttachments", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("returns empty array for unknown task", () => {
    const result = listTaskAttachments("nonexistent-task-id", "internal");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty taskId", () => {
    expect(listTaskAttachments("", "internal")).toEqual([]);
    expect(listTaskAttachments(null, "internal")).toEqual([]);
    expect(listTaskAttachments(undefined, "internal")).toEqual([]);
  });

  it("returns attachments for a known task after addTaskAttachment", () => {
    addTaskAttachment("LIST-1", "internal", {
      url: "https://example.com/report.pdf",
    });
    addTaskAttachment("LIST-1", "internal", {
      url: "https://example.com/image.png",
    });

    const result = listTaskAttachments("LIST-1", "internal");
    expect(result).toHaveLength(2);
    const urls = result.map((a) => a.url);
    expect(urls).toContain("https://example.com/report.pdf");
    expect(urls).toContain("https://example.com/image.png");
  });
});

// ── addTaskAttachment ───────────────────────────────────────────────────

describe("addTaskAttachment", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("returns null for empty taskId", () => {
    expect(addTaskAttachment("", "internal", { url: "https://x.test" })).toBeNull();
    expect(addTaskAttachment(null, "internal", { url: "https://x.test" })).toBeNull();
  });

  it("returns null for null attachment", () => {
    expect(addTaskAttachment("T-1", "internal", null)).toBeNull();
    expect(addTaskAttachment("T-1", "internal", undefined)).toBeNull();
  });

  it("adds attachment and persists to disk", () => {
    addTaskAttachment("PERSIST-1", "internal", {
      url: "https://persist.test/doc.pdf",
    });

    const filePath = join(tmpDir, "task-attachments.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.tasks).toHaveProperty("internal:PERSIST-1");
    const entry = raw.tasks["internal:PERSIST-1"];
    expect(entry.attachments).toHaveLength(1);
    expect(entry.attachments[0].url).toBe("https://persist.test/doc.pdf");
  });

  it("adds id and createdAt if missing", () => {
    const result = addTaskAttachment("META-1", "internal", {
      url: "https://meta.test/img.jpg",
    });
    expect(result).toBeDefined();
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.createdAt).toBe("string");
    expect(result.createdAt.length).toBeGreaterThan(0);
  });

  it("multiple attachments for same task are accumulated", () => {
    addTaskAttachment("MULTI-1", "internal", {
      url: "https://multi.test/a.txt",
    });
    addTaskAttachment("MULTI-1", "internal", {
      url: "https://multi.test/b.txt",
    });
    addTaskAttachment("MULTI-1", "internal", {
      url: "https://multi.test/c.txt",
    });

    const list = listTaskAttachments("MULTI-1", "internal");
    expect(list).toHaveLength(3);
    const urls = list.map((a) => a.url);
    expect(urls).toContain("https://multi.test/a.txt");
    expect(urls).toContain("https://multi.test/b.txt");
    expect(urls).toContain("https://multi.test/c.txt");
  });
});
