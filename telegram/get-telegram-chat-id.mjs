#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function getTelegramUpdateMessage(update) {
  return (
    update?.message
    || update?.channel_post
    || update?.edited_message
    || update?.edited_channel_post
    || null
  );
}

function getTelegramMessageText(message) {
  return String(message?.text || message?.caption || "").trim();
}

export function normalizeTelegramPairingCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

export function extractTelegramChatsFromUpdates(updates) {
  const chats = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = getTelegramUpdateMessage(update);
    const chat = message?.chat;
    if (!chat?.id) {
      continue;
    }
    if (!chats.has(chat.id)) {
      chats.set(chat.id, {
        id: chat.id,
        type: chat.type || "unknown",
        title: chat.title || "",
        username: chat.username || "",
      });
    }
  }
  return Array.from(chats.values());
}

function extractTelegramPairingChatFromUpdates(updates, pairingCode) {
  const normalizedCode = normalizeTelegramPairingCode(pairingCode);
  if (!normalizedCode) return null;

  for (const update of [...(Array.isArray(updates) ? updates : [])].reverse()) {
    const message = getTelegramUpdateMessage(update);
    const chat = message?.chat;
    if (!chat?.id) continue;

    const normalizedText = normalizeTelegramPairingCode(
      getTelegramMessageText(message),
    );
    if (!normalizedText || !normalizedText.includes(normalizedCode)) {
      continue;
    }

    return {
      id: chat.id,
      type: chat.type || "unknown",
      title: chat.title || "",
      username: chat.username || "",
      text: getTelegramMessageText(message),
    };
  }

  return null;
}

async function fetchTelegramUpdates(token, { fetchImpl = fetch } = {}) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  }

  const url = `https://api.telegram.org/bot${normalizedToken}/getUpdates`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Request failed: ${response.status}${body ? ` ${body}` : ""}`);
  }

  const data = await response.json();
  return Array.isArray(data?.result) ? data.result : [];
}

export async function discoverTelegramChats(token, { fetchImpl = fetch } = {}) {
  const updates = await fetchTelegramUpdates(token, { fetchImpl });
  const chats = extractTelegramChatsFromUpdates(updates);
  if (Array.isArray(updates) && updates.length === 0) {
    return {
      chats,
      message: "No updates found. Send a message to the bot first, then retry.",
    };
  }
  if (chats.length === 0) {
    return {
      chats,
      message: "No chat IDs found in updates. Send a message to the bot first.",
    };
  }
  return { chats, message: null };
}

export async function discoverTelegramPairingChat(
  token,
  pairingCode,
  { fetchImpl = fetch } = {},
) {
  const normalizedCode = normalizeTelegramPairingCode(pairingCode);
  if (!normalizedCode) {
    throw new Error("Pairing code is required.");
  }

  const updates = await fetchTelegramUpdates(token, { fetchImpl });
  const chat = extractTelegramPairingChatFromUpdates(updates, normalizedCode);
  if (chat) {
    return { chat, message: null };
  }

  return {
    chat: null,
    message:
      "Pairing code not found yet. Send the code to your bot, then retry.",
  };
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const pairArgIndex = process.argv.findIndex(
    (arg) => arg === "--pair" || arg === "-p",
  );
  const pairingCode =
    pairArgIndex >= 0 ? process.argv[pairArgIndex + 1] || "" : "";

  if (pairingCode) {
    const { chat, message } = await discoverTelegramPairingChat(
      token,
      pairingCode,
    );
    if (!chat) {
      console.log(message);
      return;
    }

    const titlePart = chat.title ? ` title="${chat.title}"` : "";
    const userPart = chat.username ? ` username=@${chat.username}` : "";
    console.log(
      `Paired chat: id=${chat.id} type=${chat.type}${userPart}${titlePart}`,
    );
    return;
  }

  const { chats, message } = await discoverTelegramChats(token);
  if (message) {
    console.log(message);
    return;
  }

  console.log("Found chat IDs:");
  for (const chat of chats) {
    const titlePart = chat.title ? ` title="${chat.title}"` : "";
    const userPart = chat.username ? ` username=@${chat.username}` : "";
    console.log(`- id=${chat.id} type=${chat.type}${userPart}${titlePart}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    await main();
  } catch (err) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
}
