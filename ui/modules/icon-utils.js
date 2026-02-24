/* ─────────────────────────────────────────────────────────────
 *  Icon utilities
 *  - Maps emoji to line-style SVG icons
 *  - Helpers for rendering icon text consistently
 * ───────────────────────────────────────────────────────────── */

import { h } from "preact";
import htm from "htm";
import { ICONS } from "./icons.js";

const html = htm.bind(h);

export const EMOJI_ICON_MAP = {
  "✅": "check",
  "✓": "check",
  "✕": "close",
  "✖": "close",
  "✗": "close",
  "✘": "close",
  "❌": "close",
  "❓": "help",
  "➕": "plus",
  "➤": "arrowRight",
  "🌍": "globe",
  "🌐": "globe",
  "🌳": "git",
  "🌿": "git",
  "🎉": "star",
  "🎛": "sliders",
  "🎤": "mic",
  "🎨": "palette",
  "🎯": "target",
  "🏁": "flag",
  "🏠": "home",
  "🏥": "heart",
  "🏷": "tag",
  "🐍": "file",
  "🐙": "git",
  "🐚": "terminal",
  "🐛": "bug",
  "👀": "eye",
  "👁": "eye",
  "👤": "user",
  "👥": "users",
  "💎": "diamond",
  "💓": "heart",
  "💚": "heart",
  "💡": "lightbulb",
  "💥": "zap",
  "💬": "chat",
  "💻": "monitor",
  "💾": "save",
  "📁": "folder",
  "📂": "folder",
  "📄": "file",
  "📈": "chart",
  "📊": "chart",
  "📋": "clipboard",
  "📌": "pin",
  "📏": "ruler",
  "📐": "ruler",
  "📖": "file",
  "📜": "file",
  "📝": "edit",
  "📡": "server",
  "📤": "upload",
  "📥": "download",
  "📦": "box",
  "📨": "mail",
  "📬": "mail",
  "📱": "phone",
  "📸": "camera",
  "🔀": "git",
  "🔁": "repeat",
  "🔄": "refresh",
  "🔌": "plug",
  "🔍": "search",
  "🔎": "search",
  "🔐": "lock",
  "🔒": "lock",
  "🔓": "unlock",
  "🔔": "bell",
  "🔗": "link",
  "🔢": "hash",
  "🔣": "terminal",
  "🔥": "zap",
  "🔧": "settings",
  "🔨": "hammer",
  "🔴": "dot",
  "🔵": "dot",
  "🔷": "diamond",
  "🖥": "monitor",
  "🗂": "folder",
  "🗃": "archive",
  "🗑": "trash",
  "🗜": "filter",
  "🗺": "grid",
  "🙈": "eyeOff",
  "🚀": "rocket",
  "🚦": "alert",
  "🚧": "alert",
  "🚨": "alert",
  "🚫": "ban",
  "🛑": "close",
  "🛡": "shield",
  "🛰": "server",
  "🟡": "dot",
  "🟢": "dot",
  "🤖": "bot",
  "🦀": "file",
  "🧠": "cpu",
  "🧪": "beaker",
  "🧭": "compass",
  "🧰": "settings",
  "🧵": "link",
  "🧹": "trash",
  "🪝": "link",
  "✨": "star",
  "⭐": "star",
  "⚙": "settings",
  "⚙️": "settings",
  "⚠": "alert",
  "⚠️": "alert",
  "⚡": "zap",
  "⏱": "clock",
  "⏱️": "clock",
  "⏸": "pause",
  "⏸️": "pause",
  "⏹": "stop",
  "⏹️": "stop",
  "▶": "play",
  "▶️": "play",
  "⏳": "clock",
  "⛔": "ban",
  "☰": "menu",
  "#️⃣": "hash",
  "🎛️": "sliders",
  "🗺️": "grid",
  "🖥️": "monitor",
  "🏷️": "tag",
  "🛰️": "server",
  "🛡️": "shield",
  "👁️": "eye",
};

export function resolveIcon(icon) {
  if (!icon) return null;
  if (ICONS[icon]) return ICONS[icon];
  const normalized = String(icon).replace(/[\uFE0E\uFE0F]/g, "");
  if (ICONS[normalized]) return ICONS[normalized];
  const mapped = EMOJI_ICON_MAP[icon] || EMOJI_ICON_MAP[normalized];
  if (mapped && ICONS[mapped]) return ICONS[mapped];
  return null;
}

export function iconText(text, { className = "" } = {}) {
  if (text == null) return text;
  const str = String(text);
  let hasIcon = false;
  const parts = [];
  let buffer = "";

  for (const ch of str) {
    if (ch === "\uFE0E" || ch === "\uFE0F") continue;
    const mapped = EMOJI_ICON_MAP[ch];
    const icon = mapped ? ICONS[mapped] : null;
    if (icon) {
      if (buffer) {
        parts.push(buffer);
        buffer = "";
      }
      parts.push(html`<span class="icon-inline" aria-hidden="true">${icon}</span>`);
      hasIcon = true;
    } else {
      buffer += ch;
    }
  }

  if (buffer) parts.push(buffer);
  if (!hasIcon) return str;

  return html`<span class="icon-text ${className}">${parts}</span>`;
}
