import { randomBytes } from 'node:crypto';

// Browser sessions are opaque random tokens held in memory. A relay restart signs everyone out,
// which is the safe default: nothing durable can leak a long-lived bearer token from the PVC.
export function createWebSessions({ ttlMs = 12 * 60 * 60_000, max = 32, now = Date.now } = {}) {
  const sessions = new Map();
  const sweep = () => {
    for (const [token, entry] of sessions) if (entry.expires <= now()) sessions.delete(token);
  };
  return {
    issue(name) {
      sweep();
      while (sessions.size >= max) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { name, expires: now() + ttlMs });
      return { token, maxAge: Math.floor(ttlMs / 1000) };
    },
    resolve(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
      const entry = sessions.get(token);
      if (!entry) return;
      if (entry.expires <= now()) {
        sessions.delete(token);
        return;
      }
      return entry.name;
    },
    revoke(token) {
      if (typeof token === 'string') sessions.delete(token);
    },
    get size() {
      return sessions.size;
    },
  };
}
