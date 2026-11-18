import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createDeviceHandler } from '../src/device-api.mjs';

const issuer = 'fixture-issuer';
const audience = 'manolo-devices';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'active', alg: 'EdDSA', use: 'sig', key_ops: ['verify'] };
const rotated = { ...other.publicKey.export({ format: 'jwk' }), kid: 'rotated' };
const config = {
  issuer, audience, keys: [key, rotated],
  grants: { tablet: { primary: ['submit', 'get'], canary: ['get'] }, reader: { primary: ['get'] } },
};
const root = '/v1/agents/primary/turns';
const auth = token => `Bearer ${token}`;
const b64 = input => Buffer.from(JSON.stringify(input)).toString('base64url');
const seconds = () => Math.floor(Date.now() / 1000);
function jwt(claims = {}, header = {}, signer = privateKey) {
  const input = `${b64({ alg: 'EdDSA', kid: 'active', ...header })}.${b64({ iss: issuer, aud: audience, sub: 'tablet', exp: seconds() + 300, ...claims })}`;
  return `${input}.${sign(null, Buffer.from(input), signer).toString('base64url')}`;
}

async function fixture(t, overrides = {}) {
  const calls = [];
  const turns = new Map();
  const handler = createDeviceHandler({ ...config,
    async submit(subject, agent, id, text) {
      calls.push(['submit', subject, agent, id, text]);
      turns.set(JSON.stringify([subject, agent, id]), { status: 'done', text, internal: 'not public' });
      return { status: 'pending' };
    },
    get(subject, agent, id) {
      calls.push(['get', subject, agent, id]);
      return turns.get(JSON.stringify([subject, agent, id]));
    },
    ...overrides,
  });
  const server = createServer(handler).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, 'listening');
  return {
    calls,
    send(method, path, { authorization, body, type = 'application/json', headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: server.address().port, method, path, headers: {
          ...(authorization !== undefined && { authorization }), ...(body !== undefined && { 'content-type': type }), ...headers,
        } }, async res => {
          try {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            resolve({ code: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) });
          } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('HTTP test timed out')));
        req.end(body);
      });
    },
  };
}

const post = (authorization, value = { id: 'turn_1', text: 'Hello' }) => ({ authorization, body: JSON.stringify(value) });

test('passes the verified subject and exact agent/turn IDs to both hooks; reads are isolated', async t => {
  const { send, calls } = await fixture(t);
  const submit = await send('POST', root, post(auth(jwt()), { id: 'turn_1', text: ' Héllo 🌍 ' }));
  assert.equal(submit.code, 200);
  assert.deepEqual(submit.body, { status: 'pending' });
  assert.equal(submit.headers['cache-control'], 'no-store');
  assert.equal(submit.headers['content-type'], 'application/json; charset=utf-8');
  const read = await send('GET', `${root}/turn_1`, { authorization: auth(jwt({ aud: ['another-api', audience], nbf: seconds() - 1 }, { kid: 'rotated', typ: 'JWT' }, other.privateKey)) });
  assert.equal(read.code, 200);
  assert.deepEqual(read.body, { status: 'done', text: ' Héllo 🌍 ' });
  assert.equal((await send('GET', `${root}/turn_1`, { authorization: auth(jwt({ sub: 'reader' })) })).code, 404);
  assert.deepEqual(calls, [
    ['submit', 'tablet', 'primary', 'turn_1', ' Héllo 🌍 '], ['get', 'tablet', 'primary', 'turn_1'], ['get', 'reader', 'primary', 'turn_1'],
  ]);
});

test('rejects invalid credentials without invoking either hook', async t => {
  const { send, calls } = await fixture(t);
  const good = jwt();
  const [header, payload, sig] = good.split('.');
  const cases = {
    missing: undefined,
    basic: 'Basic dGVzdDp0ZXN0',
    opaque: auth('opaque-token'),
    combined: `${auth(good)}, ${auth(good)}`,
    duplicate: [auth(good), auth(good)],
    oversized: auth('a'.repeat(8193)),
    padded: auth(`${header}.${payload}.${sig}=`),
    tampered: auth(`${header}.${b64({ iss: issuer, aud: audience, sub: 'reader', exp: seconds() + 300 })}.${sig}`),
    wrongKey: auth(jwt({}, {}, other.privateKey)),
    unknownKey: auth(jwt({}, { kid: 'undeclared' })),
    missingKid: auth(jwt({}, { kid: undefined })),
    wrongAlg: auth(jwt({}, { alg: 'HS256' })),
    none: auth(`${b64({ alg: 'none', kid: 'active' })}.${payload}.`),
    jku: auth(jwt({}, { jku: 'https://unused.invalid/jwks' })),
    jwk: auth(jwt({}, { jwk: key })),
    crit: auth(jwt({}, { crit: ['typ'], typ: 'JWT' })),
    noIssuer: auth(jwt({ iss: undefined })),
    wrongIssuer: auth(jwt({ iss: 'elsewhere' })),
    noAudience: auth(jwt({ aud: undefined })),
    wrongAudience: auth(jwt({ aud: `${audience}-other` })),
    invalidAudienceArray: auth(jwt({ aud: [audience, 5] })),
    noSubject: auth(jwt({ sub: undefined })),
    invalidSubject: auth(jwt({ sub: 'tablet/other' })),
    expired: auth(jwt({ exp: seconds() })),
    missingExpiry: auth(jwt({ exp: undefined })),
    stringExpiry: auth(jwt({ exp: String(seconds() + 300) })),
    futureNbf: auth(jwt({ nbf: seconds() + 300 })),
  };
  for (const [name, authorization] of Object.entries(cases)) {
    const result = await send('POST', root, { ...post(authorization), headers: { cookie: 'session=ignored', 'x-device-subject': 'tablet' } });
    assert.equal(result.code, 401, name);
    assert.equal(result.headers['www-authenticate'], 'Bearer realm="Manolo Device API"', name);
  }
  assert.deepEqual(calls, []);
});

test('enforces each subject/agent/action grant and ignores claim-supplied permissions', async t => {
  const { send, calls } = await fixture(t);
  const tablet = auth(jwt());
  const reader = auth(jwt({ sub: 'reader', scope: '*', grants: ['submit'], agent: 'primary' }));
  assert.equal((await send('POST', root, post(reader))).code, 403);
  assert.equal((await send('POST', '/v1/agents/canary/turns', post(tablet))).code, 403);
  assert.equal((await send('GET', '/v1/agents/other/turns/turn_1', { authorization: tablet })).code, 403);
  assert.equal((await send('GET', '/v1/agents/constructor/turns/turn_1', { authorization: tablet })).code, 403);
  for (const sub of ['not-granted', 'constructor', '__proto__']) {
    assert.equal((await send('GET', `${root}/turn_1`, { authorization: auth(jwt({ sub })) })).code, 403);
  }
  assert.deepEqual(calls, []);
  assert.equal((await send('GET', '/v1/agents/canary/turns/turn_1', { authorization: tablet })).code, 404);
  assert.deepEqual(calls, [['get', 'tablet', 'canary', 'turn_1']]);
});

test('rejects wrong routes, methods and input before reaching the hooks', async t => {
  const { send, calls } = await fixture(t);
  const authorization = auth(jwt());
  const options = post(authorization);
  for (const path of [`${root}/`, `${root}?x=1`, '/v1/agents/%70rimary/turns', '/v1/agents/primary/../primary/turns', `http://localhost${root}`]) {
    assert.equal((await send('POST', path, options)).code, 404, path);
  }
  const wrongMethod = await send('PUT', root, options);
  assert.equal(wrongMethod.code, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal((await send('POST', `${root}/turn_1`, options)).headers.allow, 'GET');
  assert.equal((await send('GET', `${root}/turn_1`, { headers: { 'content-length': 1 }, body: 'x', authorization })).code, 400);
  assert.equal((await send('POST', root, { ...options, type: 'text/plain' })).code, 415);
  for (const body of ['', 'null', '{', '[]', JSON.stringify({ id: '../turn', text: 'hi' }),
    JSON.stringify({ id: 'turn\n', text: 'hi' }), JSON.stringify({ id: 'x', text: ' ' }),
    JSON.stringify({ id: 'x', text: 'a'.repeat(4001) }), JSON.stringify({ id: 'x', text: 'ok', subject: 'reader' }),
    Buffer.concat([Buffer.from('{"id":"x","text":"'), Buffer.from([0xc0, 0x80]), Buffer.from('"}')]),
  ]) assert.equal((await send('POST', root, { authorization, body })).code, 400);
  const body = 'a'.repeat(32 * 1024 + 1);
  assert.equal((await send('POST', root, { authorization, body, headers: { 'content-length': body.length } })).code, 413);
  assert.equal((await send('POST', root, { authorization, body, headers: { 'transfer-encoding': 'chunked' } })).code, 413);
  assert.deepEqual(calls, []);
});

test('validates trusted configuration at construction', () => {
  const create = overrides => createDeviceHandler({ ...config, submit() {}, get() {}, ...overrides });
  assert.doesNotThrow(() => create({ grants: {} }));
  for (const overrides of [
    { issuer: '' }, { audience: [] }, { keys: [] }, { keys: [key, key] }, { keys: [{ ...key, kid: undefined }] },
    { keys: [{ ...key, crv: 'X25519' }] }, { keys: [{ ...key, d: 'private' }] }, { keys: [{ ...key, x: 'invalid' }] },
    { keys: [{ ...key, key_ops: ['sign'] }] }, { keys: [{ ...key, use: 'enc' }] }, { keys: [{ ...key, alg: 'HS256' }] },
    { grants: { '*': { primary: ['submit'] } } }, { grants: { tablet: { '*': ['get'] } } },
    { grants: { tablet: { primary: ['*'] } } }, { grants: { tablet: { primary: ['get', 'get'] } } },
    { submit: null },
  ]) assert.throws(() => create(overrides), TypeError);
});

test('handles hook errors and malformed hook responses without exposing details', async t => {
  const { send } = await fixture(t, {
    submit() { throw Object.assign(new Error('sensitive collision details'), { statusCode: 409 }); },
    get(_subject, _agent, id) {
      if (id === 'offline') throw Object.assign(new Error('sensitive upstream details'), { statusCode: 503 });
      if (id === 'broken') throw new Error('unexpected failure');
      return { status: 'invalid', text: 'private' };
    },
  });
  const authorization = auth(jwt());
  const conflict = await send('POST', root, post(authorization));
  assert.equal(conflict.code, 409);
  assert.deepEqual(conflict.body, { error: 'turn_conflict' });
  const offline = await send('GET', `${root}/offline`, { authorization });
  assert.equal(offline.code, 503);
  assert.deepEqual(offline.body, { error: 'service_unavailable' });
  for (const id of ['broken', 'malformed']) {
    const response = await send('GET', `${root}/${id}`, { authorization });
    assert.equal(response.code, 500);
    assert.deepEqual(response.body, { error: 'internal_error' });
  }
});
