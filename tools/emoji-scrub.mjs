import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const iconUtilsPath = path.join(root, "ui/modules/icon-utils.js");
const iconUtilsSource = fs.readFileSync(iconUtilsPath, "utf8");
const iconMapBlock =
  iconUtilsSource.split("export const EMOJI_ICON_MAP = {")[1]?.split("};")[0] || "";

const emojiIconMap = {};
for (const match of iconMapBlock.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
  emojiIconMap[match[1]] = match[2];
}

const extraMap = {
  ":star:": "star",
  ":help:": "help",
  ":edit:": "edit",
  ":edit:": "edit",
  ":check:": "check",
  ":workflow:": "workflow",
  ":workflow:": "workflow",
  ":arrowRight:": "arrowRight",
  ":arrowRight:": "arrowRight",
  ":arrowRight:": "arrowRight",
  ":close:": "close",
  ":dot:": "dot",
  ":dot:": "dot",
  ":dot:": "dot",
  ":dot:": "dot",
  ":hammer:": "hammer",
  ":link:": "link",
  ":target:": "target",
  ":book:": "book",
  ":workflow:": "workflow",
  ":star:": "star",
  ":mic:": "mic",
  ":close:": "close",
  ":alert:": "alert",
  ":chart:": "chart",
  ":user:": "user",
  ":users:": "users",
  ":bug:": "bug",
  ":mic:": "mic",
  ":play:": "play",
  ":lock:": "lock",
  ":globe:": "globe",
  ":dot:": "dot",
  ":link:": "link",
};

const emojiRe = /\p{Extended_Pictographic}/gu;
const skipDirs = new Set(["node_modules", ".git", ".cache", "dist", "coverage"]);
const skipFiles = new Set(["AGENTS.md"]);
const skipPaths = new Set([
  path.join(root, "ui/modules/icon-utils.js"),
  path.join(root, "site/ui/modules/icon-utils.js"),
]);
const allowExtensions = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".md",
  ".html",
  ".css",
  ".ps1",
  ".sh",
  ".yml",
  ".yaml",
  ".txt",
]);

function encodeCodePointToken(ch) {
  return `:u${ch.codePointAt(0)?.toString(16) || "unk"}:`;
}

function toToken(ch) {
  const iconName = emojiIconMap[ch] || extraMap[ch];
  if (iconName) return `:${iconName}:`;
  return encodeCodePointToken(ch);
}

function scrubText(content) {
  if (!emojiRe.test(content)) return null;
  emojiRe.lastIndex = 0;
  let replaced = content
    .replace(/\uFE0E/g, "")
    .replace(/\uFE0F/g, "")
    .replace(/\u20E3/g, "")
    .replace(emojiRe, (ch) => toToken(ch));
  return replaced;
}

function walk(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(fullPath, files);
      continue;
    }
    if (skipFiles.has(entry.name)) continue;
    if (skipPaths.has(fullPath)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!allowExtensions.has(ext)) continue;
    files.push(fullPath);
  }
  return files;
}

function toRel(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

const candidates = walk(root);
let touched = 0;
let converted = 0;
const unknownTokens = new Map();

for (const filePath of candidates) {
  let original;
  try {
    original = fs.readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  const scrubbed = scrubText(original);
  if (scrubbed == null || scrubbed === original) continue;
  touched += 1;
  for (const m of original.matchAll(emojiRe)) {
    converted += 1;
    const ch = m[0];
    if (!(emojiIconMap[ch] || extraMap[ch])) {
      unknownTokens.set(ch, (unknownTokens.get(ch) || 0) + 1);
    }
  }
  fs.writeFileSync(filePath, scrubbed, "utf8");
}

console.log(`[emoji-scrub] touched_files=${touched} converted_chars=${converted}`);
if (unknownTokens.size > 0) {
  console.log("[emoji-scrub] unmapped chars converted to :uXXXX: tokens:");
  for (const [ch, count] of [...unknownTokens.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${count}\t${ch}`);
  }
}
console.log("[emoji-scrub] done");
