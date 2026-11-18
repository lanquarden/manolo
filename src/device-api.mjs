import { createPublicKey, verify } from 'node:crypto';

const identifier = '[A-Za-z0-9_-]{1,128}';
const ID = new RegExp(`^${identifier}$`);
const ROUTE = new RegExp(`^/v1/agents/(${identifier})/turns(?:/(${identifier}))?$`);
const KID = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i;
const MAX_TOKEN = 8192;
const MAX_BODY = 32 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isConfigObject = value => isObject(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const isId = value => typeof value === 'string' && ID.test(value);
const isKid = value => typeof value === 'string' && KID.test(value);
const isNonemptyString = value => typeof value === 'string' && value.trim().length > 0;
const onlyFields = (object, fields) => Object.keys(object).every(field => fields.includes(field));
const hasBody = req => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;

function decode(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid base64url');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('Noncanonical base64url');
  return bytes;
}

function loadKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new TypeError('Device keys must be a nonempty JWK array');
  const byKid = new Map();
  for (const jwk of keys) {
    if (!isConfigObject(jwk) || !onlyFields(jwk, ['kid', 'kty', 'crv', 'x', 'alg', 'use', 'key_ops']) ||
        !['kid', 'kty', 'crv', 'x'].every(field => Object.hasOwn(jwk, field)) ||
        !isKid(jwk.kid) || byKid.has(jwk.kid) || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' ||
        (Object.hasOwn(jwk, 'alg') && jwk.alg !== 'EdDSA') || (Object.hasOwn(jwk, 'use') && jwk.use !== 'sig') ||
        (Object.hasOwn(jwk, 'key_ops') && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))) {
      throw new TypeError('Invalid or duplicate Ed25519 public JWK');
    }
    try {
      if (decode(jwk.x).length !== 32) throw new Error('Invalid Ed25519 key length');
      byKid.set(jwk.kid, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
    } catch {
      throw new TypeError('Invalid Ed25519 public JWK');
    }
  }
  return byKid;
}

function loadGrants(grants) {
  if (!isConfigObject(grants)) throw new TypeError('Device grants must be an object');
  return new Map(Object.entries(grants).map(([subject, agents]) => {
    if (!isId(subject) || !isConfigObject(agents)) throw new TypeError('Invalid device subject or agent grants');
    return [subject, new Map(Object.entries(agents).map(([agent, actions]) => {
      if (!isId(agent) || !Array.isArray(actions) || !actions.length || actions.length > 2) throw new TypeError('Invalid device agent or actions');
      const allowed = new Set();
      for (const action of actions) {
        if (!['submit', 'get'].includes(action) || allowed.has(action)) throw new TypeError('Invalid or duplicate device action');
        allowed.add(action);
      }
      return [agent, allowed];
    }))];
  }));
}

function authenticate(req, keys, issuer, audience) {
  // Node's ordinary headers view can discard a duplicate Authorization header.
  const auth = req.headersDistinct.authorization;
  if (auth?.length !== 1 || auth[0].length > MAX_TOKEN + 'Bearer '.length) return;
  const match = TOKEN.exec(auth[0]);
  if (!match) return;
  const [, headerPart, claimsPart, signaturePart] = match;
  try {
    const header = JSON.parse(utf8.decode(decode(headerPart)));
    if (!isObject(header) || !onlyFields(header, ['alg', 'kid', 'typ']) ||
        !Object.hasOwn(header, 'alg') || header.alg !== 'EdDSA' || !Object.hasOwn(header, 'kid') || !isKid(header.kid) ||
        (Object.hasOwn(header, 'typ') && header.typ !== 'JWT')) return;
    const key = keys.get(header.kid);
    if (!key) return;
    const signature = decode(signaturePart);
    if (signature.length !== 64 || !verify(null, Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'), key, signature)) return;

    const claims = JSON.parse(utf8.decode(decode(claimsPart)));
    if (!isObject(claims) || !['iss', 'aud', 'sub', 'exp'].every(field => Object.hasOwn(claims, field))) return;
    const { iss, aud, sub, exp, nbf } = claims;
    const now = Math.floor(Date.now() / 1000);
    if (iss !== issuer || !isId(sub) || !Number.isSafeInteger(exp) || exp <= now) return;
    if (aud !== audience && !(Array.isArray(aud) && aud.every(isNonemptyString) && aud.includes(audience))) return;
    if (Object.hasOwn(claims, 'nbf') && (!Number.isSafeInteger(nbf) || nbf > now)) return;
    return sub;
  } catch {
    return undefined;
  }
}

function respond(req, res, status, body, headers) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(hasBody(req) && !req.readableEnded && { connection: 'close' }),
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readSubmission(req) {
  const types = req.headersDistinct['content-type'];
  if (types?.length !== 1 || types[0].split(';')[0].trim().toLowerCase() !== 'application/json') return { error: 415 };
  if (Number(req.headers['content-length']) > MAX_BODY) return { error: 413 };
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_BODY) return { error: 413 };
      chunks.push(chunk);
    }
    const body = JSON.parse(utf8.decode(Buffer.concat(chunks)));
    if (isObject(body) && onlyFields(body, ['id', 'text']) && Object.hasOwn(body, 'id') && Object.hasOwn(body, 'text') &&
        isId(body.id) && isNonemptyString(body.text) && body.text.length <= 4000) return body;
  } catch {
    // Malformed JSON, invalid UTF-8, or incomplete input never reaches submit.
  }
  return { error: 400 };
}

/**
 * Standalone Node HTTP handler. `keys` is an array of admin-configured public
 * issuer JWKs, and `grants` is { [sub]: { [agent]: ['submit', 'get'] } } with
 * each action opted into independently. Issuer private keys stay with the issuer.
 * A signed `sub` is passed unchanged to hooks; hooks own turn persistence,
 * idempotency, and isolation by (subject, agent, id) from all other entrypoints.
 * Hooks may be async; return { status: 'pending' | 'done' | 'failed', text? }.
 * `done` requires a string `text`; `get` returns null/undefined for missing turns.
 */
export function createDeviceHandler({ issuer, audience, keys, grants, submit, get }) {
  if (!isNonemptyString(issuer) || !isNonemptyString(audience) || typeof submit !== 'function' || typeof get !== 'function') {
    throw new TypeError('Device issuer, audience, submit, and get are required');
  }
  const publicKeys = loadKeys(keys);
  const policy = loadGrants(grants);

  return async function deviceHandler(req, res) {
    const reply = (code, body, headers) => respond(req, res, code, body, headers);
    const reject = (code, error, headers) => reply(code, { error }, headers);
    const subject = authenticate(req, publicKeys, issuer, audience);
    if (!subject) return reject(401, 'unauthorized', { 'www-authenticate': 'Bearer realm="Manolo Device API"' });
    const route = ROUTE.exec(req.url);
    if (!route) return reject(404, 'not_found');
    const [, agent, turnId] = route;
    const method = turnId === undefined ? 'POST' : 'GET';
    const action = method === 'POST' ? 'submit' : 'get';
    if (req.method !== method) return reject(405, 'method_not_allowed', { allow: method });
    if (!policy.get(subject)?.get(agent)?.has(action)) return reject(403, 'forbidden');

    let body;
    if (action === 'submit') {
      body = await readSubmission(req);
      if (body.error === 415) return reject(415, 'unsupported_media_type');
      if (body.error === 413) return reject(413, 'payload_too_large');
      if (body.error === 400) return reject(400, 'bad_request');
    } else if (hasBody(req)) return reject(400, 'bad_request');

    let view;
    try {
      const result = action === 'submit' ? await submit(subject, agent, body.id, body.text) : await get(subject, agent, turnId);
      if (action === 'get' && result == null) return reject(404, 'not_found');
      const { status, text } = result;
      if (!['pending', 'done', 'failed'].includes(status) ||
          (status === 'done' && typeof text !== 'string') ||
          (status === 'failed' && text !== undefined && typeof text !== 'string')) return reject(500, 'internal_error');
      view = { status, ...(status !== 'pending' && text !== undefined && { text }) };
    } catch (error) {
      if (action === 'submit' && error?.statusCode === 409) return reject(409, 'turn_conflict');
      if (error?.statusCode === 503) return reject(503, 'service_unavailable');
      return reject(500, 'internal_error');
    }
    return reply(200, view);
  };
}
