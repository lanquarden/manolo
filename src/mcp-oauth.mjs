import { readFile, writeFile } from 'node:fs/promises';
import { createMcpAuthProvider, completeMcpSignIn, startMcpSignIn } from '@earendil-works/pi-mcp/oauth';

/**
 * OAuth for remote MCP servers, completed through the relay's https callback instead of a loopback listener: the pod
 * cannot receive an `http://127.0.0.1` redirect from the owner's browser. Tokens and registered clients live on the
 * agent's data volume, so a restart keeps the sign-in; the file is credential-grade data.
 */
export function createMcpOAuth({ statePath, publicUrl, clientName = 'Manolo', log = console }) {
  // One JSON object keyed by server URL. A store view is per server, which is what pi-mcp expects.
  let cache;
  let writes = Promise.resolve();
  let lock = Promise.resolve();

  async function readAll() {
    if (cache === undefined) {
      try {
        const raw = JSON.parse(await readFile(statePath, 'utf8'));
        cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      } catch {
        cache = {};
      }
    }
    return cache;
  }

  async function writeAll() {
    await writeFile(statePath, JSON.stringify(cache), { mode: 0o600 });
  }

  // Serialized so two concurrent refreshes cannot lose one another's rotated token.
  async function save(serverUrl, state) {
    const all = await readAll();
    if (state === undefined) delete all[serverUrl];
    else all[serverUrl] = state;
    writes = writes.then(writeAll).catch(() => {});
    await writes;
  }

  function storeFor(serverUrl) {
    return {
      async load() {
        return (await readAll())[serverUrl];
      },
      save: state => save(serverUrl, state),
      // One worker process owns a data directory, so an in-process queue is the whole lock.
      async withRefreshLock(fn) {
        const previous = lock;
        let release;
        lock = new Promise(resolve => { release = resolve; });
        await previous.catch(() => {});
        try { return await fn(); } finally { release(); }
      },
    };
  }

  const redirectUrl = typeof publicUrl === 'string' && /^https?:\/\/[^/]/.test(publicUrl)
    ? `${publicUrl.replace(/\/$/, '')}/mcp/oauth/callback`
    : undefined;
  const enabled = redirectUrl !== undefined;
  const challenges = new Map();
  const pending = new Map();

  function settingsFor(server) {
    return {
      ...(server.oauth?.clientId && { clientId: server.oauth.clientId }),
      ...(server.oauth?.clientSecret && { clientSecret: server.oauth.clientSecret }),
      ...(server.oauth?.scope && { scope: server.oauth.scope }),
      ...(server.oauth?.authServerMetadataUrl && { authServerMetadataUrl: new URL(server.oauth.authServerMetadataUrl) }),
      clientName,
    };
  }

  function optionsFor(server) {
    return {
      serverUrl: server.config.url,
      store: storeFor(server.config.url),
      settings: settingsFor(server),
      clientName,
      redirectUrl,
    };
  }

  /** Transport auth: sends and refreshes stored tokens, and reports a challenge instead of starting a browser flow. */
  function authFor(server) {
    if (!enabled) return undefined;
    return createMcpAuthProvider({
      ...optionsFor(server),
      settings: () => settingsFor(server),
      onChallenge: challenge => challenges.set(server.name, challenge),
      redirectUrl,
    });
  }

  /** First half of a sign-in: the URL the owner opens, and the state the relay callback must carry back. */
  async function begin(server) {
    if (!enabled) throw new Error('Set MANOLO_PUBLIC_URL so Manolo can receive the OAuth callback');
    const started = await startMcpSignIn({ ...optionsFor(server), ...(challenges.get(server.name) && { challenge: challenges.get(server.name) }) });
    if (started.kind === 'authorized') return { kind: 'authorized' };
    // One live sign-in per server: restarting it (or reconnecting) must not leave stale states that still complete.
    for (const [state, entry] of pending) if (entry.server === server.name) pending.delete(state);
    if (pending.size >= 32) pending.delete(pending.keys().next().value);
    pending.set(started.state, { server: server.name, authorization: started, options: optionsFor(server) });
    log.log(`MCP ${server.name}: sign-in required; open the authorization page from the workspace`);
    return { kind: 'redirect', authorizationUrl: started.authorizationUrl, state: started.state };
  }

  /** Second half: the relay hands back the authorization response, matched by the state the sign-in created. */
  async function complete(state, response) {
    const entry = pending.get(state);
    if (!entry) throw new Error('This sign-in is unknown or has expired');
    pending.delete(state);
    await completeMcpSignIn({ ...entry.options, authorization: entry.authorization, response });
    challenges.delete(entry.server);
    return entry.server;
  }

  function pendingFor(serverName) {
    for (const [state, entry] of pending) if (entry.server === serverName) return { state, authorizationUrl: entry.authorization.authorizationUrl };
  }

  async function forget(server) {
    for (const [state, entry] of pending) if (entry.server === server.name) pending.delete(state);
    challenges.delete(server.name);
    await save(server.config.url, undefined);
  }

  return { enabled, redirectUrl, authFor, begin, complete, pendingFor, forget };
}
