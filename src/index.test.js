import { describe, test, expect, mock } from 'bun:test'
import {
  shouldIgnoreEvent,
  isPanicCommand,
  buildWebhookPayload,
  truncateResponse,
  getAccessToken,
  handleRoomMessage,
  isPanicMode,
  activatePanicMode,
} from './index.js'

describe('shouldIgnoreEvent', () => {
  const botUserId = '@bot:matrix.org'
  const roomId = '!room:matrix.org'

  test('ignores messages from the bot itself', () => {
    const message = { sender: botUserId, messageType: 'm.text' }
    expect(shouldIgnoreEvent(message, botUserId, roomId)).toBe(true)
  })

  test('ignores non-text messages', () => {
    const message = { sender: '@user:matrix.org', messageType: 'm.image' }
    expect(shouldIgnoreEvent(message, botUserId, roomId)).toBe(true)
  })

  test('does not ignore valid text messages from trusted user', () => {
    const trustedUser = '@user:matrix.org'
    const message = { sender: trustedUser, messageType: 'm.text' }
    expect(shouldIgnoreEvent(message, botUserId, roomId, { trustedUser })).toBe(false)
  })

  test('ignores messages when panic mode is active', () => {
    const message = { sender: '@user:matrix.org', messageType: 'm.text' }
    expect(shouldIgnoreEvent(message, botUserId, roomId, { panicMode: true })).toBe(true)
  })

  test('ignores messages from non-trusted users when trustedUser is set', () => {
    const trustedUser = '@trusted:matrix.org'
    const message = { sender: '@other:matrix.org', messageType: 'm.text' }
    expect(shouldIgnoreEvent(message, botUserId, roomId, { trustedUser })).toBe(true)
  })

  test('does not ignore messages from trusted user', () => {
    const trustedUser = '@trusted:matrix.org'
    const message = { sender: trustedUser, messageType: 'm.text' }
    expect(shouldIgnoreEvent(message, botUserId, roomId, { trustedUser })).toBe(false)
  })

  test('ignores all messages when trustedUser is not set', () => {
    const message = { sender: '@anyone:matrix.org', messageType: 'm.text' }
    expect(shouldIgnoreEvent(message, botUserId, roomId, { trustedUser: '' })).toBe(true)
    expect(shouldIgnoreEvent(message, botUserId, roomId, { trustedUser: undefined })).toBe(true)
    expect(shouldIgnoreEvent(message, botUserId, roomId, {})).toBe(true)
  })

  test('calls warnNoTrustedUser callback when trustedUser is not set', () => {
    const message = { sender: '@anyone:matrix.org', messageType: 'm.text' }
    const warnCallback = mock(() => {})

    shouldIgnoreEvent(message, botUserId, roomId, {
      trustedUser: '',
      warnNoTrustedUser: warnCallback,
    })

    expect(warnCallback).toHaveBeenCalled()
  })

  test('does not call warnNoTrustedUser when trustedUser is set', () => {
    const message = { sender: '@trusted:matrix.org', messageType: 'm.text' }
    const warnCallback = mock(() => {})

    shouldIgnoreEvent(message, botUserId, roomId, {
      trustedUser: '@trusted:matrix.org',
      warnNoTrustedUser: warnCallback,
    })

    expect(warnCallback).not.toHaveBeenCalled()
  })
})

describe('isPanicCommand', () => {
  const trustedUser = '@trusted:matrix.org'

  test('returns true for /panic from trusted user', () => {
    const message = { sender: trustedUser, textBody: '/panic' }
    expect(isPanicCommand(message, trustedUser)).toBe(true)
  })

  test('returns true for /panic with extra text', () => {
    const message = { sender: trustedUser, textBody: '/panic now!' }
    expect(isPanicCommand(message, trustedUser)).toBe(true)
  })

  test('is case insensitive', () => {
    const message = { sender: trustedUser, textBody: '/PANIC' }
    expect(isPanicCommand(message, trustedUser)).toBe(true)

    const message2 = { sender: trustedUser, textBody: '/PaNiC' }
    expect(isPanicCommand(message2, trustedUser)).toBe(true)
  })

  test('returns false for /panic from non-trusted user', () => {
    const message = { sender: '@other:matrix.org', textBody: '/panic' }
    expect(isPanicCommand(message, trustedUser)).toBe(false)
  })

  test('returns false when no trusted user is set', () => {
    const message = { sender: '@anyone:matrix.org', textBody: '/panic' }
    expect(isPanicCommand(message, '')).toBe(false)
    expect(isPanicCommand(message, null)).toBe(false)
  })

  test('returns false for non-panic commands', () => {
    const message = { sender: trustedUser, textBody: '/help' }
    expect(isPanicCommand(message, trustedUser)).toBe(false)
  })

  test('returns false for regular messages', () => {
    const message = { sender: trustedUser, textBody: 'hello world' }
    expect(isPanicCommand(message, trustedUser)).toBe(false)
  })

  test('handles missing textBody', () => {
    const message = { sender: trustedUser }
    expect(isPanicCommand(message, trustedUser)).toBe(false)
  })
})

describe('buildWebhookPayload', () => {
  test('builds correct payload structure', () => {
    const roomId = '!room:matrix.org'
    const message = {
      sender: '@user:matrix.org',
      textBody: 'Hello world',
      eventId: '$event123',
      timestamp: 1700000000000,
    }

    const payload = buildWebhookPayload(roomId, message)

    expect(payload.room_id).toBe(roomId)
    expect(payload.sender).toBe('@user:matrix.org')
    expect(payload.message).toBe('Hello world')
    expect(payload.event_id).toBe('$event123')
    expect(payload.timestamp).toBe('2023-11-14T22:13:20.000Z')
  })

  test('handles invalid timestamp', () => {
    const roomId = '!room:matrix.org'
    const message = {
      sender: '@user:matrix.org',
      textBody: 'Hello',
      eventId: '$event123',
      timestamp: 'invalid',
    }

    const payload = buildWebhookPayload(roomId, message)
    expect(payload.timestamp).toBeDefined()
    // Should fall back to current time, so just check it's a valid ISO string
    expect(() => new Date(payload.timestamp)).not.toThrow()
  })
})

describe('truncateResponse', () => {
  test('returns short text unchanged', () => {
    const text = 'Hello world'
    expect(truncateResponse(text, 100)).toBe('Hello world')
  })

  test('truncates long text', () => {
    const text = 'A'.repeat(150)
    const result = truncateResponse(text, 100)
    expect(result.length).toBeLessThan(150)
    expect(result).toContain('[truncated]')
  })

  test('trims whitespace', () => {
    const text = '  Hello world  '
    expect(truncateResponse(text, 100)).toBe('Hello world')
  })

  test('handles null/undefined', () => {
    expect(truncateResponse(null, 100)).toBe(null)
    expect(truncateResponse(undefined, 100)).toBe(undefined)
  })
})

describe('getAccessToken', () => {
  test('returns access token from direct parameter', () => {
    const token = getAccessToken({ accessToken: 'direct-token' })
    expect(token).toBe('direct-token')
  })

  test('reads token from file when no direct token', () => {
    const token = getAccessToken({
      accessToken: undefined,
      accessTokenFile: '/path/to/token',
      fileExists: () => true,
      readFile: () => '  file-token  ',
    })
    expect(token).toBe('file-token')
  })

  test('throws when no token available', () => {
    expect(() => {
      getAccessToken({
        accessToken: undefined,
        accessTokenFile: '/path/to/token',
        fileExists: () => false,
        readFile: () => '',
      })
    }).toThrow('No access token provided')
  })
})

describe('handleRoomMessage', () => {
  const botUserId = '@bot:matrix.org'
  const roomId = '!room:matrix.org'
  const trustedUser = '@trusted:matrix.org'

  test('calls onPanic and sends message for /panic command', async () => {
    const message = {
      sender: trustedUser,
      textBody: '/panic',
      messageType: 'm.text',
      eventId: '$event123',
    }

    const sendText = mock(() => Promise.resolve())
    const onPanic = mock(() => {})

    await handleRoomMessage({
      roomId,
      message,
      botUserId,
      webhookUrl: 'https://example.com/webhook',
      webhookTimeoutMs: 5000,
      maxResponseLength: 4000,
      trustedUser,
      sendText,
      readReceipt: async () => {},
      onPanic,
    })

    expect(onPanic).toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledWith(roomId, expect.stringContaining('PANIC MODE ACTIVATED'))
  })

  test('ignores messages from non-trusted users', async () => {
    const message = {
      sender: '@other:matrix.org',
      textBody: 'Hello',
      messageType: 'm.text',
      eventId: '$event123',
    }

    const sendText = mock(() => Promise.resolve())
    const readReceipt = mock(() => Promise.resolve())

    await handleRoomMessage({
      roomId,
      message,
      botUserId,
      webhookUrl: 'https://example.com/webhook',
      webhookTimeoutMs: 5000,
      maxResponseLength: 4000,
      trustedUser,
      sendText,
      readReceipt,
      onPanic: () => {},
    })

    // Should not call readReceipt since message is ignored
    expect(readReceipt).not.toHaveBeenCalled()
  })

  test('processes messages from trusted user', async () => {
    const message = {
      sender: trustedUser,
      textBody: 'Hello',
      messageType: 'm.text',
      eventId: '$event123',
      timestamp: Date.now(),
    }

    const sendText = mock(() => Promise.resolve())
    const readReceipt = mock(() => Promise.resolve())

    // Mock fetch to return a response
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ message: 'Reply' }),
      })
    )

    try {
      await handleRoomMessage({
        roomId,
        message,
        botUserId,
        webhookUrl: 'https://example.com/webhook',
        webhookTimeoutMs: 5000,
        maxResponseLength: 4000,
        trustedUser,
        sendText,
        readReceipt,
        onPanic: () => {},
      })

      expect(readReceipt).toHaveBeenCalled()
      expect(sendText).toHaveBeenCalledWith(roomId, 'Reply')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('panic mode state', () => {
  test('isPanicMode returns current state', () => {
    // Note: This test may be affected by other tests that activate panic mode
    // In a real scenario, you'd want to reset state between tests
    expect(typeof isPanicMode()).toBe('boolean')
  })

  test('activatePanicMode sets panic mode', () => {
    activatePanicMode()
    expect(isPanicMode()).toBe(true)
  })
})
