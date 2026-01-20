import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs'
import {
  SimpleFsStorageProvider,
  LogLevel,
  LogService,
  MatrixClient,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  MatrixAuth,
  MessageEvent,
} from 'matrix-bot-sdk'
import { readFileSync, existsSync } from 'fs'
import { password as promptPassword, input as promptInput } from '@inquirer/prompts';
import { setTimeout } from 'timers/promises';

function initLogs() {
  const logLevels = {
    'TRACE': LogLevel.TRACE,
    'DEBUG': LogLevel.DEBUG,
    'INFO': LogLevel.INFO,
    'WARN': LogLevel.WARN,
    'ERROR': LogLevel.ERROR,
  }
  const levelStr = process.env.LOG_LEVEL || 'INFO'
  const level = logLevels[levelStr.toUpperCase()] || LogLevel.INFO
  LogService.setLogger(new RichConsoleLogger())
  LogService.setLevel(level)
  LogService.muteModule('Metrics')
  LogService.trace = LogService.debug
}

initLogs()

// Config from env
const HOMESERVER_URL = process.env.HOMESERVER_URL || 'https://matrix.org'
const WEBHOOK_URL = process.env.WEBHOOK_URL
const DEVICE_NAME = process.env.DEVICE_NAME || 'Matrix Webhook Relay Bot'
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '30000')
const MAX_RESPONSE_LENGTH = parseInt(process.env.MAX_RESPONSE_LENGTH || '4000')
const ALLOWED_ROOMS =
  process.env.ALLOWED_ROOMS?.split(',')
    .map((r) => r.trim())
    .filter(Boolean) || []

const log = (...args) => {
  LogService.info('Bot', ...args)
}
const error = (...args) => {
  LogService.error('Bot', ...args)
}
const debug = (...args) => {
  LogService.debug('Bot', ...args)
}

/**
 * Check if a message event should be ignored (own messages, wrong room, non-text)
 * @param {object} message - The Matrix event
 * @param {string} botUserId - The bot's user ID
 * @param {string} roomId - The room the message was sent in
 * @param {string[]} allowedRooms - List of allowed room IDs (empty means all rooms allowed)
 * @returns {boolean} True if the event should be ignored
 */
export function shouldIgnoreEvent(message, botUserId, roomId, allowedRooms) {
  if (message.sender === botUserId) return true
  if (allowedRooms.length && !allowedRooms.includes(roomId)) return true
  if (message.messageType !== 'm.text') return true
  return false
}

/**
 * Build the webhook payload from a Matrix event
 * @param {string} roomId - The room ID
 * @param {object} message - The Matrix event
 * @returns {object} The webhook payload
 */
export function buildWebhookPayload(roomId, message) {
  const timestamp = new Date(message.origin_server_ts).toISOString()
  return {
    room_id: roomId,
    sender: message.sender,
    message: message.textBody,
    event_id: message.event_id,
    timestamp,
  }
}

/**
 * Extract a reply message from a webhook response
 * @param {Response} response - The fetch Response object
 * @returns {Promise<string|null>} The extracted reply text or null
 */
export async function extractReplyFromResponse(response) {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const data = await response.json()
    return data.message || data.text || data.response || data.body || null
  } else {
    return await response.text()
  }
}

/**
 * Truncate text if it exceeds the maximum length
 * @param {string} text - The text to potentially truncate
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} The original or truncated text
 */
export function truncateResponse(text, maxLength) {
  if (!text) return text
  const trimmed = text.trim()
  if (trimmed.length > maxLength) {
    return trimmed.slice(0, maxLength) + '… [truncated]'
  }
  return trimmed
}

/**
 * Prepare the final reply text (trim and truncate if needed)
 * @param {string|null} reply - The raw reply text
 * @param {number} maxLength - Maximum allowed length
 * @returns {string|null} The prepared reply or null if empty
 */
export function prepareReplyText(reply, maxLength) {
  if (!reply || !reply.trim()) return null
  return truncateResponse(reply, maxLength)
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/**
 * Handle an incoming Matrix room message
 * @param {object} params - Handler parameters
 * @param {string} params.roomId - The room ID
 * @param {object} params.message - The Matrix event
 * @param {string} params.botUserId - The bot's user ID
 * @param {string[]} params.allowedRooms - List of allowed room IDs
 * @param {string} params.webhookUrl - The webhook URL
 * @param {number} params.webhookTimeoutMs - Webhook request timeout
 * @param {number} params.maxResponseLength - Maximum response length
 * @param {function} params.sendText - Function to send text to a room
 */
export async function handleRoomMessage({
  roomId,
  message,
  botUserId,
  allowedRooms,
  webhookUrl,
  webhookTimeoutMs,
  maxResponseLength,
  sendText,
}) {
  if (shouldIgnoreEvent(message, botUserId, roomId, allowedRooms)) {
    log(`Ignoring message in ${roomId} from ${message.sender}`)
    return
  }

  debug(`[${roomId}] ${message.sender}`, message)

  try {
    const payload = buildWebhookPayload(roomId, message)
    const response = await forwardToWebhook(webhookUrl, payload, webhookTimeoutMs)

    if (!response.ok) {
      error(`Webhook returned ${response.status}`)
      return
    }

    const reply = await extractReplyFromResponse(response)
    const text = prepareReplyText(reply, maxResponseLength)

    if (text) {
      await sendText(roomId, text)
    }
  } catch (err) {
    error(`Error forwarding message: ${err.message}`)
    await sendText(roomId, '⚠️ Error processing your message.')
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
  accessTokenFile = process.env.ACCESS_TOKEN_FILE || '/run/secrets/access_token',
  fileExists = existsSync,
  readFile = readFileSync,
} = {}) {
  if (accessToken) {
    return accessToken
  }
  if (fileExists(accessTokenFile)) {
    return readFile(accessTokenFile, 'utf-8').trim()
  }
  throw new Error('No access token provided. Set ACCESS_TOKEN or ACCESS_TOKEN_FILE.')
}

async function doLogin() {
  // Get credentials from prompt
  const username = await promptInput({
    message: 'Matrix Username (e.g., user not @user:matrix.org):'
  })
  const password = await promptPassword({
    message: 'Matrix Password:'
  })
  const auth = new MatrixAuth(HOMESERVER_URL)
  const client = await auth.passwordLogin(username, password, DEVICE_NAME)
  console.log('\n*** Copy this access token and set it in your environment ***\n')
  console.log('ACCESS_TOKEN', client.accessToken)
}

async function joinRooms(client, allowedRooms) {
  const rooms = await client.getJoinedRooms()
  for (const roomId of allowedRooms) {
    if (!rooms.includes(roomId)) {
      log(`Joining room ${roomId}`)
      try {
        await client.joinRoom(roomId)
        log(`Joined room ${roomId}`)
      } catch (err) {
        error(`Failed to join room ${roomId}: ${err.message}`)
      }
    }
  }
  // leave unlisted rooms
  for (const roomId of rooms) {
    if (allowedRooms.length && !allowedRooms.includes(roomId)) {
      log(`Leaving unlisted room ${roomId}`)
      try {
        await client.leaveRoom(roomId)
        log(`Left room ${roomId}`)
      } catch (err) {
        error(`Failed to leave room ${roomId}: ${err.message}`)
      }
    }
  }
}

async function main() {
  // Check if we need to login based on "login" argument
  const login = process.argv.includes('login')
  if (login) {
    await setTimeout(500)
    await doLogin()
    process.exit(0)
  }

  if (!WEBHOOK_URL) {
    throw new Error('WEBHOOK_URL is required')
  }

  const accessToken = getAccessToken()
  const storage = new SimpleFsStorageProvider('/data/bot-state.json')
  const crypto = new RustSdkCryptoStorageProvider('/data/bot_sqlite', StoreType.Sqlite);
  const client = new MatrixClient(HOMESERVER_URL, accessToken, storage, crypto);
  const botUserId = await client.getUserId()
  log(`Bot logged in as ${botUserId}`)
  log(`Forwarding messages to ${WEBHOOK_URL}`)
  log(`E2E encryption enabled with crypto storage at ${'/data/bot_sqlite'}`)

  // Handle failed decryption events
  client.on('room.failed_decryption', async (roomId, event, error) => {
    error(`[${roomId}] Failed to decrypt message from ${event.sender}: ${error.message}`)
  })

  client.on('room.message', async (roomId, event) => {
    const message = new MessageEvent(event)
    await handleRoomMessage({
      roomId,
      message,
      botUserId,
      allowedRooms: ALLOWED_ROOMS,
      webhookUrl: WEBHOOK_URL,
      webhookTimeoutMs: WEBHOOK_TIMEOUT_MS,
      maxResponseLength: MAX_RESPONSE_LENGTH,
      sendText: (room, text) => client.sendText(room, text),
    })
  })

  client.on('room.invite', async (roomId) => {
    log(`Got invited to room ${roomId}`)
    if (ALLOWED_ROOMS.length === 0 || ALLOWED_ROOMS.includes(roomId)) {
      try {
        await client.joinRoom(roomId)
        log(`Joined room ${roomId} on invite`)
      } catch (err) {
        error(`Failed to join room ${roomId} on invite: ${err.message}`)
      }
    } else {
      log(`Ignoring invite to unlisted room ${roomId}`)
    }
  })

  client.on('space.invite', async (roomId) => {
    log(`Got invited to space ${roomId}`)
  })

  await client.start()
  await joinRooms(client, ALLOWED_ROOMS)
  log('Bot started and listening')
}

// handle sigterm
process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down...')
  process.exit(0)
})

main().catch((err) => {
  error('Fatal error:', err)
  process.exit(1)
})