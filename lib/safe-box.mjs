/**
 * safe-box.mjs — Terminal-safe box-drawing for console banners.
 *
 * Detects whether the current terminal supports Unicode box-drawing
 * characters and falls back to plain ASCII when it does not.
 * This prevents mojibake on Windows consoles with non-UTF-8 codepages
 * (e.g. CP 437/1252 rendering ╭ as Ôö¼).
 */

import { execSync } from "node:child_process";

function terminalSupportsUnicode() {
  if (process.env.CI) return true;
  if (process.env.WT_SESSION) return true;
  const tp = process.env.TERM_PROGRAM || "";
  if (tp === "vscode" || tp === "iTerm.app" || tp === "Hyper") return true;
  if (process.platform !== "win32") return true;
  try {
    const cp = execSync("chcp", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
    if (cp.includes("65001")) return true;
  } catch { /* can't detect — assume no */ }
  const lang = String(process.env.LANG || process.env.LC_ALL || "").toLowerCase();
  if (lang.includes("utf-8") || lang.includes("utf8")) return true;
  return false;
}

const UNICODE_OK = terminalSupportsUnicode();

const BOX = UNICODE_OK
  ? { tl: "\u256D", tr: "\u256E", bl: "\u2570", br: "\u256F", h: "\u2500", v: "\u2502" }
  : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

const SAFE_ARROW = UNICODE_OK ? "\u2192" : "->";

/**
 * Build a framed banner box for console output.
 * @param {string[]} lines — content lines (will be padded to fit)
 * @param {number} [width=58] — inner width (excluding border chars)
 * @returns {string} — multi-line banner string ready for console.log()
 */
function safeBanner(lines, width = 58) {
  const top = `  ${BOX.tl}${BOX.h.repeat(width)}${BOX.tr}`;
  const bot = `  ${BOX.bl}${BOX.h.repeat(width)}${BOX.br}`;
  const rows = lines.map((line) => {
    const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
    const pad = Math.max(0, width - 2 - visible.length);
    return `  ${BOX.v} ${line}${" ".repeat(pad)}${BOX.v}`;
  });
  return [top, ...rows, bot].join("\n");
}

export { safeBanner, BOX, SAFE_ARROW, UNICODE_OK, terminalSupportsUnicode };
