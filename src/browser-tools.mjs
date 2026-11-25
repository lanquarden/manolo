import { setTimeout as sleep } from 'node:timers/promises';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

// The worker drives the Chromium sidecar in its own pod over the DevTools protocol on loopback. The same browser is
// visible to the owner through the relay's noVNC desktop, so the agent and the person can watch and act together.
// Nothing here launches a second browser: a missing sidecar is an error the model can report, not a hidden fallback.
const REF = /^e[0-9]{1,4}$/;
const MAX_URL = 2048;
const MAX_SNAPSHOT = 6000;
const MAX_ELEMENTS = 120;
const MAX_PAGE_TEXT = 1500;
const MAX_SHOT_BASE64 = 4_000_000;
const READY_POLLS = 40;
const READY_INTERVAL_MS = 200;

const clip = (value, limit) => value.length > limit ? `${value.slice(0, limit)}…` : value;

function schema(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const text = (value, limit) => ({ type: 'string', minLength: 1, maxLength: limit });
const ref = { type: 'string', pattern: '^e[0-9]{1,4}$' };

class Cdp {
  #socket;
  #pending = new Map();
  #next = 1;

  static async open(endpoint, signal) {
    const target = new URL('/json/version', endpoint);
    let info;
    try {
      const response = await fetch(target, { redirect: 'error', signal, headers: { accept: 'application/json' } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`status ${response.status}`);
      }
      info = await response.json();
    } catch {
      throw new Error('The agent browser is not running. Its pod may be starting; this command did not run.');
    }
    const socket = new WebSocket(info.webSocketDebuggerUrl);
    const cdp = new Cdp(socket);
    await cdp.#opened(signal);
    return cdp;
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      const data = typeof event.data === 'string' ? event.data : undefined;
      if (data === undefined) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(clip(String(message.error.message ?? 'DevTools error'), 300)));
      else waiter.resolve(message.result ?? {});
    });
    const fail = () => {
      for (const waiter of this.#pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('The agent browser closed the connection'));
      }
      this.#pending.clear();
    };
    socket.addEventListener('close', fail);
    socket.addEventListener('error', fail);
  }

  #opened(signal) {
    return new Promise((resolve, reject) => {
      const open = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('The agent browser refused the DevTools connection')); };
      const abort = () => { cleanup(); reject(new Error('The browser command was cancelled')); };
      const cleanup = () => {
        this.#socket.removeEventListener('open', open);
        this.#socket.removeEventListener('error', fail);
        signal?.removeEventListener('abort', abort);
      };
      this.#socket.addEventListener('open', open);
      this.#socket.addEventListener('error', fail);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  send(method, params = {}, sessionId, { timeoutMs = 10_000 } = {}) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The agent browser did not answer ${method} in time`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  close() {
    try { this.#socket.close(); } catch { /* already closed */ }
  }
}

async function pages(endpoint, signal) {
  let list;
  try {
    const response = await fetch(new URL('/json/list', endpoint), { redirect: 'error', signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`status ${response.status}`);
    }
    list = await response.json();
  } catch {
    throw new Error('The agent browser is not running. Its pod may be starting; this command did not run.');
  }
  if (!Array.isArray(list)) return [];
  return list.filter(page => page?.type === 'page' && typeof page.id === 'string' && !String(page.url).startsWith('devtools://'))
    .map(page => ({ id: page.id, url: String(page.url ?? ''), title: String(page.title ?? '') }));
}

// The agent and the owner may both switch tabs, so the worker remembers only its own last target and re-derives it
// whenever Chromium reports a different set.
let currentTarget;

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(clip(String(exceptionDetails.text ?? 'The page raised an exception'), 300));
  return result?.value;
}

async function settle(cdp, sessionId, signal) {
  for (let attempt = 0; attempt < READY_POLLS; attempt++) {
    if (signal?.aborted) return;
    const state = await evaluate(cdp, sessionId, 'document.readyState').catch(() => undefined);
    if (state === 'complete') break;
    await sleep(READY_INTERVAL_MS, undefined, { signal: signal ?? undefined }).catch(() => {});
  }
  // Single-page apps render after the load event; a short pause avoids snapshotting an empty shell.
  await sleep(300, undefined, { signal: signal ?? undefined }).catch(() => {});
}

// One expression builds the whole outline: stable element refs, roles and names, then the page's own text. It is
// deliberately boring DOM rather than a full accessibility tree, because it has to work on any page the owner opens.
function snapshotExpression() {
  return `(() => {
    const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[contenteditable=""],[contenteditable="true"],[onclick]';
    const clean = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const visible = element => {
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
    };
    const roleOf = element => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'summary') return 'summary';
      if (tag !== 'input') return tag;
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    };
    const nameOf = element => clean(
      element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('alt') ||
      (element.labels && element.labels[0] && element.labels[0].innerText) || element.innerText || element.value ||
      element.getAttribute('name') || element.getAttribute('title') || ''
    ).slice(0, 80);
    for (const stale of document.querySelectorAll('[data-manolo-ref]')) stale.removeAttribute('data-manolo-ref');
    const lines = [];
    let index = 0;
    for (const element of document.querySelectorAll(INTERACTIVE)) {
      if (index >= ${MAX_ELEMENTS}) break;
      if (!visible(element)) continue;
      index += 1;
      const tag = 'e' + index;
      element.setAttribute('data-manolo-ref', tag);
      const parts = ['[' + tag + ']', roleOf(element), JSON.stringify(nameOf(element))];
      if (element.disabled) parts.push('(disabled)');
      if (element.tagName === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) parts.push(element.checked ? '(checked)' : '(unchecked)');
      if (element.value && element.tagName !== 'BUTTON') parts.push('value=' + JSON.stringify(String(element.value).slice(0, 80)));
      const href = element.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) parts.push('-> ' + href.slice(0, 120));
      lines.push(parts.join(' '));
    }
    const text = clean(document.body ? document.body.innerText : '').slice(0, ${MAX_PAGE_TEXT});
    return { url: location.href, title: document.title, snapshot: lines.join('\\n'), text };
  })()`;
}

function formatSnapshot({ url, title, snapshot, text }) {
  const header = `${clip(String(title ?? ''), 120) || '(no title)'} — ${clip(String(url ?? ''), 300)}`;
  const elements = snapshot ? `Elements:\n${clip(snapshot, MAX_SNAPSHOT)}` : 'Elements: none found';
  return `${header}\n\n${elements}${text ? `\n\nPage text:\n${clip(text, MAX_PAGE_TEXT)}` : ''}`;
}

async function readPage(cdp, sessionId) {
  const page = await evaluate(cdp, sessionId, snapshotExpression());
  if (!page) throw new Error('The page returned no snapshot');
  return formatSnapshot(page);
}

function assertUrl(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_URL) throw new Error('The URL is not usable');
  let url;
  try { url = new URL(value); } catch { throw new Error('The URL is not absolute'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are offered');
  return url.toString();
}

const KEYS = new Map(Object.entries({
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}));

// Accepts `Enter`, `PageDown`, or a modifier combination such as `ctrl+a` / `shift+Tab`.
function keyEvents(spec) {
  if (typeof spec !== 'string' || spec.length === 0 || spec.length > 40) throw new Error('The key is not usable');
  const parts = spec.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const flag = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }[part.toLowerCase()];
    if (flag === undefined) throw new Error(`Unknown modifier: ${clip(part, 20)}`);
    modifiers |= flag;
  }
  const known = KEYS.get(name.length === 1 ? (name === ' ' ? 'Space' : name) : name);
  const events = known ?? (/^[a-zA-Z0-9]$/.test(name) ? {
    key: name, code: /[a-zA-Z]/.test(name) ? `Key${name.toUpperCase()}` : `Digit${name}`, keyCode: name.toUpperCase().charCodeAt(0),
  } : undefined);
  if (!events) throw new Error(`Unsupported key: ${clip(name, 20)}`);
  const base = { modifiers, key: events.key, code: events.code, windowsVirtualKeyCode: events.keyCode, nativeVirtualKeyCode: events.keyCode };
  const down = { type: 'keyDown', ...base, ...(events.text && modifiers === 0 ? { text: events.text, unmodifiedText: events.text } : {}) };
  return [down, { type: 'keyUp', ...base }];
}

async function press(cdp, sessionId, spec) {
  const [down, up] = keyEvents(spec);
  await cdp.send('Input.dispatchKeyEvent', down, sessionId);
  await cdp.send('Input.dispatchKeyEvent', up, sessionId);
}

async function focusElement(cdp, sessionId, refValue) {
  const found = await evaluate(cdp, sessionId, `(() => {
    const element = document.querySelector('[data-manolo-ref="${refValue}"]');
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus({ preventScroll: true });
    return true;
  })()`);
  if (!found) throw new Error('That ref is not on the page any more; take a new snapshot');
}

async function clickElement(cdp, sessionId, refValue) {
  const box = await evaluate(cdp, sessionId, `(() => {
    const element = document.querySelector('[data-manolo-ref="${refValue}"]');
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  if (!box) throw new Error('That ref is not on the page any more; take a new snapshot');
  const pointer = { x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pointer, buttons: 0 }, sessionId);
}

/**
 * Installs the `browser_*` tools when the operator gave the worker a Chromium sidecar endpoint. Without one, the agent
 * is not offered a browser at all rather than being handed a tool that fails at runtime.
 */
export function installBrowserTools(registry, { endpoint = process.env.MANOLO_BROWSER_CDP, signal } = {}) {
  if (!endpoint) return;
  let base;
  try { base = new URL(endpoint); } catch { throw new Error('MANOLO_BROWSER_CDP must be an http origin'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      (base.pathname !== '/' && base.pathname !== '') || !['127.0.0.1', '::1', 'localhost'].includes(base.hostname)) {
    throw new Error('MANOLO_BROWSER_CDP must be a loopback http origin');
  }

  // Every call opens its own short DevTools connection, so a restarted sidecar never leaves a stale session behind.
  async function withPage({ create = false, url = 'about:blank' }, run) {
    const cdp = await Cdp.open(base, signal);
    try {
      let targetId;
      if (create) {
        ({ targetId } = await cdp.send('Target.createTarget', { url }, undefined, { timeoutMs: 15_000 }));
      } else {
        const list = await pages(base, AbortSignal.timeout(5_000));
        targetId = list.find(page => page.id === currentTarget)?.id ?? list.at(-1)?.id;
        if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
      }
      currentTarget = targetId;
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      return await run({ cdp, sessionId, targetId });
    } finally {
      cdp.close();
    }
  }

  const open = defineTool({
    name: 'browser_open', callers: ['model'], replay: 'unsafe',
    description: 'Open a URL in the shared agent browser, or use newTab to keep the current page. Returns the page title, its interactive elements with refs, and its visible text.',
    parameters: schema({ url: text(MAX_URL), newTab: { type: 'boolean' } }, ['url']),
    async execute({ url, newTab }, _api, context) {
      const target = assertUrl(url);
      return { output: [{ type: 'text', text: await withPage({ create: newTab === true, url: target }, async ({ cdp, sessionId }) => {
        if (newTab !== true) await cdp.send('Page.navigate', { url: target }, sessionId);
        await settle(cdp, sessionId, context.abortSignal);
        return readPage(cdp, sessionId);
      }) }] };
    },
  });

  const snapshot = defineTool({
    name: 'browser_snapshot', callers: ['model'], replay: 'safe',
    description: 'Describe the page the browser is showing: title, URL, interactive elements with click/type refs, and visible text.',
    parameters: schema({}),
    async execute(_args, _api, context) {
      return { output: [{ type: 'text', text: await withPage({}, ({ cdp, sessionId }) => readPage(cdp, sessionId)) }] };
    },
  });

  const click = defineTool({
    name: 'browser_click', callers: ['model'], replay: 'unsafe',
    description: 'Click the element with a ref from the latest snapshot. Returns the resulting page.',
    parameters: schema({ ref }),
    async execute({ ref: refValue }, _api, context) {
      if (!REF.test(refValue)) throw new Error('The ref is not a snapshot ref such as e7');
      return { output: [{ type: 'text', text: await withPage({}, async ({ cdp, sessionId }) => {
        await clickElement(cdp, sessionId, refValue);
        await settle(cdp, sessionId, context.abortSignal);
        return readPage(cdp, sessionId);
      }) }] };
    },
  });

  const type = defineTool({
    name: 'browser_type', callers: ['model'], replay: 'unsafe',
    description: 'Type text into the element with a ref from the latest snapshot, or into whatever is focused when ref is omitted. submit presses Enter afterwards.',
    parameters: schema({ text: text(4000), ref, submit: { type: 'boolean' } }, ['text']),
    async execute({ text: value, ref: refValue, submit }, _api, context) {
      if (refValue !== undefined && !REF.test(refValue)) throw new Error('The ref is not a snapshot ref such as e7');
      return { output: [{ type: 'text', text: await withPage({}, async ({ cdp, sessionId }) => {
        if (refValue !== undefined) await focusElement(cdp, sessionId, refValue);
        await cdp.send('Input.insertText', { text: value }, sessionId);
        if (submit === true) await press(cdp, sessionId, 'Enter');
        await settle(cdp, sessionId, context.abortSignal);
        return readPage(cdp, sessionId);
      }) }] };
    },
  });

  const key = defineTool({
    name: 'browser_key', callers: ['model'], replay: 'unsafe',
    description: 'Press one key in the browser, such as Enter, Tab, Escape, PageDown, or a combination like ctrl+a.',
    parameters: schema({ key: text(40) }),
    async execute({ key: spec }, _api, context) {
      keyEvents(spec);
      return { output: [{ type: 'text', text: await withPage({}, async ({ cdp, sessionId }) => {
        await press(cdp, sessionId, spec);
        await settle(cdp, sessionId, context.abortSignal);
        return readPage(cdp, sessionId);
      }) }] };
    },
  });

  const screenshot = defineTool({
    name: 'browser_screenshot', callers: ['model'], replay: 'safe',
    description: 'Capture what the browser is showing as a JPEG image, for pages whose layout matters more than their text.',
    parameters: schema({}),
    async execute() {
      const { data, text: summary } = await withPage({}, async ({ cdp, sessionId }) => {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 }, sessionId);
        const details = await evaluate(cdp, sessionId, '({ url: location.href, title: document.title })');
        return { data: String(shot.data ?? ''), text: `${details.title || '(no title)'} — ${details.url}` };
      });
      if (!data || data.length > MAX_SHOT_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error('The browser returned no usable screenshot');
      }
      return { output: [{ type: 'text', text: summary }, { type: 'image', data, mimeType: 'image/jpeg' }] };
    },
  });

  const tabs = defineTool({
    name: 'browser_tabs', callers: ['model'], replay: 'unsafe',
    description: 'List the browser tabs, or select or close one by its id. The selected tab receives later browser_open, click, type and key calls.',
    parameters: schema({ action: { type: 'string', enum: ['list', 'select', 'close'] }, tab: { type: 'string', pattern: '^[A-F0-9]{8,32}$' } }, ['action']),
    async execute({ action, tab }) {
      const list = await pages(base, AbortSignal.timeout(5_000));
      const lines = list.map(page => `${page.id === currentTarget ? '*' : ' '} ${page.id} ${clip(page.title || '(no title)', 80)} — ${clip(page.url, 200)}`);
      if (action === 'list') return { output: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No tabs are open' }] };
      const target = list.find(page => page.id === tab);
      if (!target) throw new Error('No tab has that id; list the tabs again');
      const cdp = await Cdp.open(base, signal);
      try {
        if (action === 'close') {
          await cdp.send('Target.closeTarget', { targetId: target.id });
          if (currentTarget === target.id) currentTarget = undefined;
          return { output: [{ type: 'text', text: `Closed ${target.id}` }] };
        }
        await cdp.send('Target.activateTarget', { targetId: target.id });
        currentTarget = target.id;
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
        return { output: [{ type: 'text', text: await readPage(cdp, sessionId) }] };
      } finally {
        cdp.close();
      }
    },
  });

  registry.install(defineExtension({ name: 'manolo-browser', tools: [open, snapshot, click, type, key, screenshot, tabs] }));
  return { open, snapshot, click, type, key, screenshot, tabs };
}
