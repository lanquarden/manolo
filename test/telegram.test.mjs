import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createTelegramTransport } from '../src/telegram.mjs';

const token = '12345:mock-token';
const baseUrl = 'http://127.0.0.1:1234/bot-api/';
const json = (result) => Response.json({ ok: true, result });
const message = (changes = {}) => ({
  from: { id: 123, is_bot: false },
  chat: { id: 456, type: 'private' },
  text: '  Hello, <Manolo>!  ',
  ...changes,
});

function harness(reply = () => json({})) {
  const calls = [];
  const transport = createTelegramTransport({
    token,
    baseUrl,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...init, body: JSON.parse(init.body) });
      return reply(url, init);
    },
  });
  return { ...transport, calls };
}

test('poll posts a long-poll request and sorts cursor entries, including ignored updates', async () => {
  const updates = [
    { update_id: 36, message: message({ text: '😀'.repeat(2001) }) },
    { update_id: 24, message: message({ chat: { id: -1, type: 'group' } }) },
    { update_id: 27, edited_message: message() },
    { update_id: 31, message: message({ from: { id: 123, is_bot: true } }) },
    { update_id: 32, message: message({ forward_origin: { type: 'hidden_user' } }) },
    { update_id: 33, message: message({ forward_date: 123 }) },
    { update_id: 34, message: message({ text: undefined, caption: 'caption' }) },
    { update_id: 37, message: message({ is_automatic_forward: true }) },
    { update_id: 38, message: message({ chat: { id: 456, type: 'channel' } }) },
    { update_id: 39, message: message({ chat: { id: 456 } }) },
    { update_id: 40, message: message({ chat: { id: '456', type: 'private' } }) },
    { update_id: 41, message: message({ chat: { id: -456, type: 'private' } }) },
    { update_id: 42, message: message({ from: { id: Number.MAX_SAFE_INTEGER + 1 } }) },
    { update_id: 43, message: message({ from: { id: 0 } }) },
    { update_id: 44, callback_query: {} },
    { update_id: 21, message: message() },
    { update_id: 45, message: message({ text: '😀'.repeat(2000) }) },
    { update_id: '50', message: message() },
    { update_id: 0, message: message() },
    { update_id: -1, message: message() },
    { update_id: 51.5, message: message() },
    { update_id: Number.MAX_SAFE_INTEGER + 1, message: message() },
    null,
  ];
  const { poll, calls } = harness(() => json(updates));
  const envelope = { transport: 'telegram', userId: '123', chatId: '456', text: message().text };
  assert.deepEqual(await poll(21), [
    { updateId: 21, envelope },
    ...[24, 27, 31, 32, 33, 34, 36, 37, 38, 39, 40, 41, 42, 43, 44]
      .map((updateId) => ({ updateId, envelope: null })),
    { updateId: 45, envelope: { ...envelope, text: '😀'.repeat(2000) } },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${baseUrl}bot${token}/getUpdates`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.equal(calls[0].redirect, 'error');
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.deepEqual(calls[0].body, { offset: 21, timeout: 25, allowed_updates: ['message'] });
});

test('send posts plain text and makes at most one request for long output', async () => {
  const { send, calls } = harness();
  const short = '*not markdown* <b>not HTML</b>';
  const exact = '😀'.repeat(2048);
  const suffix = '\n\n[truncated]';
  const prefix = 'x'.repeat(4096 - suffix.length - 1);
  await send({ chatId: '456', text: short });
  await send({ chatId: '456', text: exact });
  // The next character would be cut in the middle of a surrogate pair.
  await send({ chatId: '456', text: `${prefix}😀${'z'.repeat(4100)}` });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ url, method, redirect, body }) => ({ url, method, redirect, body })),
    [short, exact, prefix + suffix].map((text) => ({
      url: `${baseUrl}bot${token}/sendMessage`, method: 'POST', redirect: 'error',
      body: { chat_id: '456', text },
    })));
});

test('only HTTPS or loopback HTTP endpoints are accepted', async () => {
  for (const baseUrl of [
    'http://example.test', 'http://localhost.example.test', 'http://127.0.0.1.example.test',
    'http://127.example.test', 'http://0.0.0.0', 'ftp://localhost', 'https://user:pass@example.test',
    'https://example.test/?secret=1', 'https://example.test/#secret',
  ]) {
    assert.throws(() => createTelegramTransport({ token, baseUrl }), /Invalid Telegram base URL/);
  }
  for (const baseUrl of ['http://127.0.0.2:1234', 'http://localhost:1234', 'http://[::1]:1234']) {
    assert.doesNotThrow(() => createTelegramTransport({ token, baseUrl }));
  }
  const { poll } = createTelegramTransport({ token, fetchImpl(url, init) {
    assert.equal(String(url), `https://api.telegram.org/bot${token}/getUpdates`);
    assert.equal(JSON.parse(init.body).offset, 0);
    return json([]);
  } });
  assert.deepEqual(await poll(), []);
});

test('native fetch refuses a redirect from a loopback mock', { timeout: 5_000 }, async (t) => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    request.resume();
    if (request.url.endsWith('/sendMessage')) {
      response.writeHead(307, { location: '/redirect-target' });
    } else {
      response.setHeader('content-type', 'application/json');
      response.write(JSON.stringify({ ok: true, result: {} }));
    }
    response.end();
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { send } = createTelegramTransport({ token, baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(send({ chatId: '1', text: 'hi' }), {
    message: 'Telegram request failed', permanent: false,
  });
  assert.deepEqual(paths, [`/bot${token}/sendMessage`]);
});

test('definitive 4xx are permanent; network, timeout, rate-limit and malformed replies are retryable', async () => {
  const privateBody = `private response containing ${token}`;
  const cases = [
    [() => new Response(privateBody, { status: 401 }), true],
    [() => new Response(privateBody, { status: 403 }), true],
    [() => new Response(privateBody, { status: 408 }), false],
    [() => new Response(privateBody, { status: 425 }), false],
    [() => new Response(privateBody, { status: 429 }), false],
    [() => new Response(privateBody, { status: 503 }), false],
    [() => Response.json({ ok: false, error_code: 400, description: privateBody }), true],
    [() => Response.json({ ok: false, error_code: 429, description: privateBody }), false],
    [() => Response.json({ ok: false, error_code: 400, description: privateBody }, { status: 502 }), false],
    [() => new Response(privateBody), false],
    [() => { throw new Error(`fetch failed: ${privateBody}`, { cause: new Error(token) }); }, false],
  ];
  for (const [reply, permanent] of cases) {
    const { send, calls } = harness(reply);
    await assert.rejects(send({ chatId: '1', text: 'hi' }), (error) => {
      assert.equal(error.permanent, permanent);
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(privateBody));
      assert.ok(!error.stack.includes(token));
      return true;
    });
    assert.equal(calls.length, 1, 'the caller owns all retry decisions');
  }
  await assert.rejects(harness(() => json({})).poll(1), { permanent: false });
});

test('caller cancellation reaches an in-flight request and pre-abort makes no request', async () => {
  const abort = new AbortController();
  const { poll, calls } = harness((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = poll(1, abort.signal);
  abort.abort(new Error(token));
  await assert.rejects(pending, { message: 'Telegram request cancelled', permanent: false });
  await assert.rejects(poll(1, abort.signal), { message: 'Telegram request cancelled', permanent: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
});

test('request deadlines cover reading the response and allow the poll to hold longer', async (t) => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    const abort = new AbortController();
    deadlines.push({ milliseconds, abort });
    return abort.signal;
  });
  for (const invoke of [(t) => t.poll(0), (t) => t.send({ chatId: '1', text: 'hi' })]) {
    const bodyStarted = Promise.withResolvers();
    const transport = harness((_, { signal }) => ({
      ok: true,
      json: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        bodyStarted.resolve();
      }),
    }));
    const pending = invoke(transport);
    await bodyStarted.promise;
    deadlines.at(-1).abort.abort(new Error(token));
    await assert.rejects(pending, { message: 'Telegram request timed out', permanent: false });
  }
  assert.ok(deadlines[0].milliseconds > 25_000 && deadlines[0].milliseconds <= 60_000);
  assert.ok(deadlines[1].milliseconds > 0 && deadlines[1].milliseconds < deadlines[0].milliseconds);
});

test('invalid caller input does not become a Telegram request', async () => {
  const { poll, send, calls } = harness();
  await assert.rejects(poll(-1), /Invalid Telegram offset/);
  await assert.rejects(send({ chatId: '9007199254740992', text: 'hi' }), /Invalid Telegram chat ID/);
  await assert.rejects(send({ chatId: '1', text: '' }), /Invalid Telegram text/);
  assert.equal(calls.length, 0);
  assert.throws(() => createTelegramTransport({ token: 'bad/path' }), /Invalid Telegram token/);
});
