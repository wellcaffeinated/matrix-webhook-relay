import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "matrix-bot-sdk";
import { readFileSync, existsSync } from "fs";

// Config from env
const HOMESERVER_URL = process.env.HOMESERVER_URL || "https://matrix.org";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || "30000");
const MAX_RESPONSE_LENGTH = parseInt(process.env.MAX_RESPONSE_LENGTH || "4000");
const ALLOWED_ROOMS = process.env.ROOM_ID?.split(",").map((r) => r.trim()).filter(Boolean) || [];

/**
 * Check if an event should be ignored (own messages, wrong room, non-text)
 * @param {object} event - The Matrix event
 * @param {string} botUserId - The bot's user ID
 * @param {string} roomId - The room the message was sent in
 * @param {string[]} allowedRooms - List of allowed room IDs (empty means all rooms allowed)
 * @returns {boolean} True if the event should be ignored
 */
export function shouldIgnoreEvent(event, botUserId, roomId, allowedRooms) {
  if (event.sender === botUserId) return true;
  if (allowedRooms.length && !allowedRooms.includes(roomId)) return true;
  if (event.content?.msgtype !== "m.text") return true;
  return false;
}

/**
 * Build the webhook payload from a Matrix event
 * @param {string} roomId - The room ID
 * @param {object} event - The Matrix event
 * @returns {object} The webhook payload
 */
export function buildWebhookPayload(roomId, event) {
  return {
    room_id: roomId,
    sender: event.sender,
    message: event.content.body,
    event_id: event.event_id,
  };
}

/**
 * Extract a reply message from a webhook response
 * @param {Response} response - The fetch Response object
 * @returns {Promise<string|null>} The extracted reply text or null
 */
export async function extractReplyFromResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = await response.json();
    return data.message || data.text || data.response || data.body || null;
  } else {
    return await response.text();
  }
}

/**
 * Truncate text if it exceeds the maximum length
 * @param {string} text - The text to potentially truncate
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} The original or truncated text
 */
export function truncateResponse(text, maxLength) {
  if (!text) return text;
  const trimmed = text.trim();
  if (trimmed.length > maxLength) {
    return trimmed.slice(0, maxLength) + "… [truncated]";
  }
  return trimmed;
}

/**
 * Prepare the final reply text (trim and truncate if needed)
 * @param {string|null} reply - The raw reply text
 * @param {number} maxLength - Maximum allowed length
 * @returns {string|null} The prepared reply or null if empty
 */
export function prepareReplyText(reply, maxLength) {
  if (!reply || !reply.trim()) return null;
  return truncateResponse(reply, maxLength);
}

/**
 * Forward a message to the webhook and get the response
 * @param {string} webhookUrl - The webhook URL
 * @param {object} payload - The payload to send
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<Response>} The fetch response
 */
export async function forwardToWebhook(webhookUrl, payload, timeoutMs) {
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Handle an incoming Matrix room message
 * @param {object} params - Handler parameters
 * @param {string} params.roomId - The room ID
 * @param {object} params.event - The Matrix event
 * @param {string} params.botUserId - The bot's user ID
 * @param {string[]} params.allowedRooms - List of allowed room IDs
 * @param {string} params.webhookUrl - The webhook URL
 * @param {number} params.webhookTimeoutMs - Webhook request timeout
 * @param {number} params.maxResponseLength - Maximum response length
 * @param {function} params.sendText - Function to send text to a room
 */
export async function handleRoomMessage({
  roomId,
  event,
  botUserId,
  allowedRooms,
  webhookUrl,
  webhookTimeoutMs,
  maxResponseLength,
  sendText,
}) {
  if (shouldIgnoreEvent(event, botUserId, roomId, allowedRooms)) {
    return;
  }

  const message = event.content.body;
  console.log(`[${roomId}] ${event.sender}: ${message}`);

  try {
    const payload = buildWebhookPayload(roomId, event);
    const response = await forwardToWebhook(webhookUrl, payload, webhookTimeoutMs);

    if (!response.ok) {
      console.error(`Webhook returned ${response.status}`);
      return;
    }

    const reply = await extractReplyFromResponse(response);
    const text = prepareReplyText(reply, maxResponseLength);

    if (text) {
      await sendText(roomId, text);
    }
  } catch (err) {
    console.error(`Error forwarding message: ${err.message}`);
    await sendText(roomId, "⚠️ Error processing your message.");
  }
}

/**
 * Read access token from environment variable or file
 * @param {object} options - Options for token retrieval
 * @param {string} [options.accessToken] - Direct access token
 * @param {string} [options.accessTokenFile] - Path to token file
 * @param {function} [options.fileExists] - Function to check file existence
 * @param {function} [options.readFile] - Function to read file contents
 * @returns {string} The access token
 * @throws {Error} If no access token is available
 */
export function getAccessToken({
  accessToken = process.env.ACCESS_TOKEN,
  accessTokenFile = process.env.ACCESS_TOKEN_FILE || "/run/secrets/matrix_token",
  fileExists = existsSync,
  readFile = readFileSync,
} = {}) {
  if (accessToken) {
    return accessToken;
  }
  if (fileExists(accessTokenFile)) {
    return readFile(accessTokenFile, "utf-8").trim();
  }
  throw new Error("No access token provided. Set ACCESS_TOKEN or ACCESS_TOKEN_FILE.");
}

async function main() {
  if (!WEBHOOK_URL) {
    throw new Error("WEBHOOK_URL is required");
  }

  const accessToken = getAccessToken();
  const storage = new SimpleFsStorageProvider("/data/bot-state.json");

  const client = new MatrixClient(HOMESERVER_URL, accessToken, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  const botUserId = await client.getUserId();
  console.log(`Bot logged in as ${botUserId}`);
  console.log(`Forwarding messages to ${WEBHOOK_URL}`);

  client.on("room.message", async (roomId, event) => {
    await handleRoomMessage({
      roomId,
      event,
      botUserId,
      allowedRooms: ALLOWED_ROOMS,
      webhookUrl: WEBHOOK_URL,
      webhookTimeoutMs: WEBHOOK_TIMEOUT_MS,
      maxResponseLength: MAX_RESPONSE_LENGTH,
      sendText: (room, text) => client.sendText(room, text),
    });
  });

  await client.start();
  console.log("Bot started and listening");
}

// Only run main() when this file is executed directly, not when imported
if (import.meta.main || (typeof process !== 'undefined' && process.argv[1]?.endsWith('index.js'))) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
