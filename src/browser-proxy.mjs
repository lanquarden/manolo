import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

// A worker browser's web desktop is never public. The relay terminates the owner's Basic Auth and forwards only to
// the worker pod that belongs to that owner's agent, so one owner can never reach another agent's browser. Chromium
// itself is only reachable at the worker's loopback CDP port.
export const DESKTOP_PATH = '/desktop';
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// The proxied desktop is a same-origin frame inside the workspace, so it needs a policy its own assets can satisfy.
const DESKTOP_CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' data: blob:; " +
  "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
const UPSTREAM_TIMEOUT_MS = 20_000;

// Operator-provided JSON such as {"primary":"http://manolo-primary:5800"}. Anything but an http origin is refused at
// startup, so a typo cannot become a credential leak or a proxy to the internet.
export function readBrowserUrls(value) {
  const urls = new Map();
  if (value === undefined || value === '') return urls;
  if (typeof value !== 'string') throw new Error('MANOLO_BROWSER_URLS must be JSON text');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('MANOLO_BROWSER_URLS is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MANOLO_BROWSER_URLS must be a mapping');
  for (const [agent, raw] of Object.entries(parsed)) {
    if (!AGENT_ID.test(agent)) throw new Error(`MANOLO_BROWSER_URLS has an invalid agent id: ${agent.slice(0, 40)}`);
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error(`MANOLO_BROWSER_URLS.${agent} must be a URL string`);
    let url;
    try { url = new URL(raw); } catch { throw new Error(`MANOLO_BROWSER_URLS.${agent} is not a URL`); }
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error(`MANOLO_BROWSER_URLS.${agent} must be a plain http origin`);
    }
    urls.set(agent, url);
  }
  return urls;
}

export function isDesktopPath(path) {
  return path === DESKTOP_PATH || path.startsWith(`${DESKTOP_PATH}/`);
}

function forwardedHeaders(headers, { upgrade = false } = {}) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    // The owner's Basic credentials and the relay's cookies stay at the relay.
    if (HOP_BY_HOP.has(name) && !(upgrade && (name === 'connection' || name === 'upgrade'))) continue;
    if (name === 'authorization' || name === 'cookie' || name.startsWith('x-forwarded-')) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function responseHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    // The desktop must not set cookies on the workspace origin, and the relay decides caching and framing headers.
    if (name === 'set-cookie' || name === 'cache-control' || name === 'content-security-policy' ||
        name === 'content-security-policy-report-only' || name === 'x-frame-options' || name === 'referrer-policy' ||
        name === 'cross-origin-opener-policy' || name === 'cross-origin-embedder-policy' ||
        name === 'cross-origin-resource-policy') continue;
    kept[name] = value;
  }
  return kept;
}

const refusal = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${message}\n`);
};

// Forwards one desktop request to `base` (the worker's web desktop origin). `rest` is the path below /desktop.
export function proxyDesktop(req, res, base, rest, search = '') {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) return refusal(res, 405, 'Method not allowed');
  const path = `${rest || '/'}${search}`;
  const upstream = httpRequest({
    host: base.hostname, port: base.port, method: req.method, path, headers: forwardedHeaders(req.headers), timeout: UPSTREAM_TIMEOUT_MS,
  }, answer => {
    res.writeHead(answer.statusCode ?? 502, {
      ...responseHeaders(answer.headers), 'cache-control': 'no-store', 'content-security-policy': DESKTOP_CSP,
      'x-content-type-options': 'nosniff',
    });
    answer.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    refusal(res, 503, 'The agent browser is not reachable right now.');
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

// noVNC upgrades /desktop/websockify. Tunnelling the raw TCP stream keeps the relay out of the VNC protocol.
export function upgradeDesktop(req, socket, head, base) {
  const rest = req.url.startsWith(DESKTOP_PATH) ? req.url.slice(DESKTOP_PATH.length) || '/' : null;
  if (!rest || !rest.startsWith('/')) return false;
  socket.setTimeout(0);
  const upstream = connect(Number(base.port || 80), base.hostname, () => {
    const headers = forwardedHeaders(req.headers, { upgrade: true });
    const lines = [`GET ${rest} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const each of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${each}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.setNoDelay(true);
  socket.setNoDelay(true);
  // A desktop connection is long-lived; neither end may be closed by an idle timeout.
  upstream.setTimeout(0);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  return true;
}
