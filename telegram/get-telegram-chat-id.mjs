#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function extractTelegramChatsFromUpdates(updates) {
  const chats = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update?.message || update?.channel_post || update?.edited_message;
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

export async function discoverTelegramChats(token, { fetchImpl = fetch } = {}) {
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
  const updates = data?.result;
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

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
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
