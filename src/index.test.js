import { describe, it, expect, jest, beforeEach, afterEach, mock } from 'bun:test';

// Mock matrix-bot-sdk before importing index.js
mock.module('matrix-bot-sdk', () => ({
  MatrixClient: class MockMatrixClient {
    constructor() {}
    getUserId() { return Promise.resolve('@bot:matrix.org'); }
    sendText() { return Promise.resolve(); }
    on() {}
    start() { return Promise.resolve(); }
  },
  SimpleFsStorageProvider: class MockStorageProvider {
    constructor() {}
  },
  AutojoinRoomsMixin: {
    setupOnClient: () => {},
  },
}));

const {
  shouldIgnoreEvent,
  buildWebhookPayload,
  extractReplyFromResponse,
  truncateResponse,
  prepareReplyText,
  forwardToWebhook,
  handleRoomMessage,
  getAccessToken,
} = await import('./index.js');

describe('shouldIgnoreEvent', () => {
  const botUserId = '@bot:matrix.org';
  const allowedRooms = ['!room1:matrix.org', '!room2:matrix.org'];

  it('should ignore events from the bot itself', () => {
    const event = { sender: '@bot:matrix.org', content: { msgtype: 'm.text' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });

  it('should ignore events from rooms not in the allowed list', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.text' } };
    expect(shouldIgnoreEvent(event, botUserId, '!other:matrix.org', allowedRooms)).toBe(true);
  });

  it('should not ignore events when allowedRooms is empty (all rooms allowed)', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.text' } };
    expect(shouldIgnoreEvent(event, botUserId, '!any:matrix.org', [])).toBe(false);
  });

  it('should ignore events with non-text message types', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.image' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });

  it('should ignore events with missing content', () => {
    const event = { sender: '@user:matrix.org' };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });

  it('should ignore events with null content', () => {
    const event = { sender: '@user:matrix.org', content: null };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });

  it('should not ignore valid text events from allowed rooms', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.text' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(false);
  });

  it('should not ignore valid text events from the second allowed room', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.text' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room2:matrix.org', allowedRooms)).toBe(false);
  });

  it('should ignore events with missing msgtype', () => {
    const event = { sender: '@user:matrix.org', content: { body: 'Hello' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });

  it('should ignore events with m.notice message type', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.notice' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });

  it('should ignore events with m.emote message type', () => {
    const event = { sender: '@user:matrix.org', content: { msgtype: 'm.emote' } };
    expect(shouldIgnoreEvent(event, botUserId, '!room1:matrix.org', allowedRooms)).toBe(true);
  });
});

describe('buildWebhookPayload', () => {
  it('should build payload with all required fields', () => {
    const roomId = '!room:matrix.org';
    const event = {
      sender: '@user:matrix.org',
      content: { body: 'Hello world' },
      event_id: '$event123',
    };

    const payload = buildWebhookPayload(roomId, event);

    expect(payload).toEqual({
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      message: 'Hello world',
      event_id: '$event123',
    });
  });

  it('should handle empty message body', () => {
    const roomId = '!room:matrix.org';
    const event = {
      sender: '@user:matrix.org',
      content: { body: '' },
      event_id: '$event123',
    };

    const payload = buildWebhookPayload(roomId, event);

    expect(payload.message).toBe('');
  });

  it('should handle undefined message body', () => {
    const roomId = '!room:matrix.org';
    const event = {
      sender: '@user:matrix.org',
      content: {},
      event_id: '$event123',
    };

    const payload = buildWebhookPayload(roomId, event);

    expect(payload.message).toBeUndefined();
  });

  it('should handle multiline message body', () => {
    const roomId = '!room:matrix.org';
    const event = {
      sender: '@user:matrix.org',
      content: { body: 'Line 1\nLine 2\nLine 3' },
      event_id: '$event123',
    };

    const payload = buildWebhookPayload(roomId, event);

    expect(payload.message).toBe('Line 1\nLine 2\nLine 3');
  });

  it('should handle special characters in message body', () => {
    const roomId = '!room:matrix.org';
    const event = {
      sender: '@user:matrix.org',
      content: { body: 'Hello <script>alert("xss")</script> & "quotes"' },
      event_id: '$event123',
    };

    const payload = buildWebhookPayload(roomId, event);

    expect(payload.message).toBe('Hello <script>alert("xss")</script> & "quotes"');
  });
});

describe('extractReplyFromResponse', () => {
  it('should extract message from JSON response with "message" field', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Hello from webhook' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Hello from webhook');
  });

  it('should extract text from JSON response with "text" field', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ text: 'Text response' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Text response');
  });

  it('should extract response from JSON with "response" field', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ response: 'Response field' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Response field');
  });

  it('should extract body from JSON with "body" field', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ body: 'Body field' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Body field');
  });

  it('should prioritize message over other fields', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Message', text: 'Text', response: 'Response', body: 'Body' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Message');
  });

  it('should return null for JSON without recognized fields', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 'ok', data: {} }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBeNull();
  });

  it('should return plain text for non-JSON responses', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'Plain text response',
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Plain text response');
  });

  it('should handle JSON with charset in content-type', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => ({ message: 'With charset' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('With charset');
  });

  it('should handle missing content-type header', async () => {
    const response = {
      headers: new Headers(),
      text: async () => 'Fallback text',
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Fallback text');
  });

  it('should handle empty text response', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => '',
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('');
  });

  it('should prioritize text over response field', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ text: 'Text', response: 'Response', body: 'Body' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Text');
  });

  it('should prioritize response over body field', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ response: 'Response', body: 'Body' }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('Response');
  });

  it('should handle HTML content-type as text', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<p>HTML response</p>',
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBe('<p>HTML response</p>');
  });

  it('should handle empty JSON object', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBeNull();
  });

  it('should return null for JSON with empty string values (falsy)', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: '' }),
    };

    const reply = await extractReplyFromResponse(response);
    // Empty string is falsy, so it falls through and returns null
    expect(reply).toBeNull();
  });

  it('should handle JSON with null message value', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: null }),
    };

    const reply = await extractReplyFromResponse(response);
    expect(reply).toBeNull();
  });
});

describe('truncateResponse', () => {
  it('should return text unchanged if under max length', () => {
    const text = 'Hello world';
    expect(truncateResponse(text, 100)).toBe('Hello world');
  });

  it('should truncate text exceeding max length', () => {
    const text = 'a'.repeat(100);
    const result = truncateResponse(text, 50);
    expect(result.length).toBe(50 + '… [truncated]'.length);
    expect(result).toBe('a'.repeat(50) + '… [truncated]');
  });

  it('should trim whitespace from text', () => {
    const text = '  Hello world  ';
    expect(truncateResponse(text, 100)).toBe('Hello world');
  });

  it('should return null for null input', () => {
    expect(truncateResponse(null, 100)).toBeNull();
  });

  it('should return undefined for undefined input', () => {
    expect(truncateResponse(undefined, 100)).toBeUndefined();
  });

  it('should return empty string for empty input', () => {
    expect(truncateResponse('', 100)).toBe('');
  });

  it('should handle text exactly at max length', () => {
    const text = 'a'.repeat(50);
    expect(truncateResponse(text, 50)).toBe('a'.repeat(50));
  });

  it('should handle text one character over max length', () => {
    const text = 'a'.repeat(51);
    const result = truncateResponse(text, 50);
    expect(result).toBe('a'.repeat(50) + '… [truncated]');
  });

  it('should handle zero max length', () => {
    const text = 'Hello';
    const result = truncateResponse(text, 0);
    expect(result).toBe('… [truncated]');
  });

  it('should handle unicode characters correctly', () => {
    const text = 'Hello';
    expect(truncateResponse(text, 100)).toBe('Hello');
  });

  it('should trim text before checking length', () => {
    const text = '   ' + 'a'.repeat(50) + '   ';
    expect(truncateResponse(text, 50)).toBe('a'.repeat(50));
  });
});

describe('prepareReplyText', () => {
  it('should return null for null input', () => {
    expect(prepareReplyText(null, 100)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(prepareReplyText('', 100)).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(prepareReplyText('   ', 100)).toBeNull();
    expect(prepareReplyText('\n\t', 100)).toBeNull();
  });

  it('should trim and return valid text', () => {
    expect(prepareReplyText('  Hello  ', 100)).toBe('Hello');
  });

  it('should truncate long text', () => {
    const longText = 'a'.repeat(100);
    const result = prepareReplyText(longText, 50);
    expect(result).toBe('a'.repeat(50) + '… [truncated]');
  });

  it('should handle text with only newlines', () => {
    expect(prepareReplyText('\n\n\n', 100)).toBeNull();
  });

  it('should preserve internal whitespace', () => {
    expect(prepareReplyText('  Hello  World  ', 100)).toBe('Hello  World');
  });

  it('should return null for undefined input', () => {
    expect(prepareReplyText(undefined, 100)).toBeNull();
  });

  it('should handle text exactly at max length', () => {
    const text = 'a'.repeat(50);
    expect(prepareReplyText(text, 50)).toBe('a'.repeat(50));
  });
});

describe('forwardToWebhook', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should call fetch with correct parameters', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const webhookUrl = 'https://example.com/webhook';
    const payload = { message: 'test' };
    const timeoutMs = 5000;

    await forwardToWebhook(webhookUrl, payload, timeoutMs);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(webhookUrl);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(options.body).toBe(JSON.stringify(payload));
    expect(options.signal).toBeDefined();
  });

  it('should return the fetch response', async () => {
    const mockResponse = { ok: true, status: 200 };
    globalThis.fetch = jest.fn().mockResolvedValue(mockResponse);

    const result = await forwardToWebhook('https://example.com', {}, 5000);
    expect(result).toBe(mockResponse);
  });

  it('should propagate fetch errors', async () => {
    const error = new Error('Network error');
    globalThis.fetch = jest.fn().mockRejectedValue(error);

    await expect(forwardToWebhook('https://example.com', {}, 5000)).rejects.toThrow('Network error');
  });

  it('should correctly serialize complex payload', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const payload = {
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      message: 'Hello with "quotes" and special chars <>&',
      event_id: '$event123',
      nested: { key: 'value' },
    };

    await forwardToWebhook('https://example.com/webhook', payload, 5000);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBe(JSON.stringify(payload));
  });

  it('should handle empty payload', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    await forwardToWebhook('https://example.com/webhook', {}, 5000);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBe('{}');
  });
});

describe('handleRoomMessage', () => {
  let sendTextMock;
  let originalFetch;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    sendTextMock = jest.fn().mockResolvedValue(undefined);
    originalFetch = globalThis.fetch;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  const createParams = (overrides = {}) => ({
    roomId: '!room:matrix.org',
    event: {
      sender: '@user:matrix.org',
      content: { msgtype: 'm.text', body: 'Hello' },
      event_id: '$event123',
    },
    botUserId: '@bot:matrix.org',
    allowedRooms: [],
    webhookUrl: 'https://example.com/webhook',
    webhookTimeoutMs: 5000,
    maxResponseLength: 4000,
    sendText: sendTextMock,
    ...overrides,
  });

  it('should ignore events from the bot itself', async () => {
    const params = createParams({
      event: {
        sender: '@bot:matrix.org',
        content: { msgtype: 'm.text', body: 'Hello' },
        event_id: '$event123',
      },
    });

    await handleRoomMessage(params);

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should ignore events from non-allowed rooms', async () => {
    const params = createParams({
      allowedRooms: ['!other:matrix.org'],
    });

    await handleRoomMessage(params);

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should ignore non-text events', async () => {
    const params = createParams({
      event: {
        sender: '@user:matrix.org',
        content: { msgtype: 'm.image' },
        event_id: '$event123',
      },
    });

    await handleRoomMessage(params);

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should forward message to webhook and send reply', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Webhook reply' }),
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', 'Webhook reply');
  });

  it('should not send reply when webhook returns empty response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should not send reply when webhook returns whitespace-only response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => '   ',
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should log error when webhook returns non-ok status', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Webhook returned 500');
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should send error message when fetch fails', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error forwarding message: Network failure');
    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', '⚠️ Error processing your message.');
  });

  it('should truncate long webhook responses', async () => {
    const longMessage = 'a'.repeat(100);
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: longMessage }),
    });

    const params = createParams({ maxResponseLength: 50 });
    await handleRoomMessage(params);

    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', 'a'.repeat(50) + '… [truncated]');
  });

  it('should log the incoming message', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleLogSpy).toHaveBeenCalledWith('[!room:matrix.org] @user:matrix.org: Hello');
  });

  it('should process message from allowed room', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Reply' }),
    });

    const params = createParams({
      allowedRooms: ['!room:matrix.org', '!other:matrix.org'],
    });
    await handleRoomMessage(params);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', 'Reply');
  });

  it('should send correct payload to webhook', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    });

    const params = createParams();
    await handleRoomMessage(params);

    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      message: 'Hello',
      event_id: '$event123',
    });
  });

  it('should handle text/plain response from webhook', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'Plain text reply',
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', 'Plain text reply');
  });

  it('should handle 404 response from webhook', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Webhook returned 404');
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should handle 401 response from webhook', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Webhook returned 401');
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('should handle timeout error from fetch', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'AbortError';
    globalThis.fetch = jest.fn().mockRejectedValue(timeoutError);

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error forwarding message: The operation was aborted');
    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', '⚠️ Error processing your message.');
  });

  it('should handle JSON parse errors gracefully', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => { throw new Error('Invalid JSON'); },
    });

    const params = createParams();
    await handleRoomMessage(params);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error forwarding message: Invalid JSON');
    expect(sendTextMock).toHaveBeenCalledWith('!room:matrix.org', '⚠️ Error processing your message.');
  });

  it('should not log when ignoring bot messages', async () => {
    const params = createParams({
      event: {
        sender: '@bot:matrix.org',
        content: { msgtype: 'm.text', body: 'Bot message' },
        event_id: '$event123',
      },
    });

    await handleRoomMessage(params);

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('should handle sendText failures gracefully in success path', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Reply' }),
    });

    const failingSendText = jest.fn().mockRejectedValue(new Error('Send failed'));
    const params = createParams({ sendText: failingSendText });

    // The function should throw when sendText fails
    await expect(handleRoomMessage(params)).rejects.toThrow('Send failed');
  });
});

describe('getAccessToken', () => {
  it('should return access token from direct parameter', () => {
    const token = getAccessToken({ accessToken: 'direct-token' });
    expect(token).toBe('direct-token');
  });

  it('should prioritize direct token over file', () => {
    const fileExists = jest.fn().mockReturnValue(true);
    const readFile = jest.fn().mockReturnValue('file-token');

    const token = getAccessToken({
      accessToken: 'direct-token',
      accessTokenFile: '/path/to/token',
      fileExists,
      readFile,
    });

    expect(token).toBe('direct-token');
    expect(fileExists).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('should read token from file when direct token not provided', () => {
    const fileExists = jest.fn().mockReturnValue(true);
    const readFile = jest.fn().mockReturnValue('  file-token  ');

    const token = getAccessToken({
      accessToken: undefined,
      accessTokenFile: '/path/to/token',
      fileExists,
      readFile,
    });

    expect(token).toBe('file-token');
    expect(fileExists).toHaveBeenCalledWith('/path/to/token');
    expect(readFile).toHaveBeenCalledWith('/path/to/token', 'utf-8');
  });

  it('should throw error when no token available', () => {
    const fileExists = jest.fn().mockReturnValue(false);
    const readFile = jest.fn();

    expect(() => getAccessToken({
      accessToken: undefined,
      accessTokenFile: '/nonexistent',
      fileExists,
      readFile,
    })).toThrow('No access token provided. Set ACCESS_TOKEN or ACCESS_TOKEN_FILE.');

    expect(readFile).not.toHaveBeenCalled();
  });

  it('should use default file path when not specified', () => {
    const fileExists = jest.fn().mockReturnValue(true);
    const readFile = jest.fn().mockReturnValue('token');

    getAccessToken({
      accessToken: undefined,
      fileExists,
      readFile,
    });

    expect(fileExists).toHaveBeenCalledWith('/run/secrets/matrix_token');
  });

  it('should trim whitespace from file token', () => {
    const fileExists = jest.fn().mockReturnValue(true);
    const readFile = jest.fn().mockReturnValue('\n  token-with-whitespace  \n');

    const token = getAccessToken({
      accessToken: undefined,
      accessTokenFile: '/path/to/token',
      fileExists,
      readFile,
    });

    expect(token).toBe('token-with-whitespace');
  });

  it('should handle empty string access token as falsy', () => {
    const fileExists = jest.fn().mockReturnValue(true);
    const readFile = jest.fn().mockReturnValue('file-token');

    const token = getAccessToken({
      accessToken: '',
      accessTokenFile: '/path/to/token',
      fileExists,
      readFile,
    });

    expect(token).toBe('file-token');
  });

  it('should throw error with descriptive message', () => {
    const fileExists = jest.fn().mockReturnValue(false);
    const readFile = jest.fn();

    try {
      getAccessToken({
        accessToken: undefined,
        accessTokenFile: '/nonexistent',
        fileExists,
        readFile,
      });
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e.message).toContain('ACCESS_TOKEN');
      expect(e.message).toContain('ACCESS_TOKEN_FILE');
    }
  });

  it('should handle token file with only whitespace', () => {
    const fileExists = jest.fn().mockReturnValue(true);
    const readFile = jest.fn().mockReturnValue('   \n\t   ');

    const token = getAccessToken({
      accessToken: undefined,
      accessTokenFile: '/path/to/token',
      fileExists,
      readFile,
    });

    // Result is empty string after trim
    expect(token).toBe('');
  });

  it('should not call readFile if accessToken is provided', () => {
    const fileExists = jest.fn();
    const readFile = jest.fn();

    getAccessToken({
      accessToken: 'my-token',
      accessTokenFile: '/path/to/token',
      fileExists,
      readFile,
    });

    expect(fileExists).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
