import { setTimeout as sleep } from 'node:timers/promises';

// Ephemeral UI hint only. Nothing here may delay dispatch, alter retry state,
// or fall back to sending a chat message.
export function createTypingActivity(send, signal, { initial = 700, refresh = 4000, backoff = 15000, limit = 10 } = {}) {
  const active = new Map();
  function end(chatId) {
    const entry = active.get(chatId);
    if (!entry) return;
    active.delete(chatId);
    entry.abort();
  }
  signal.addEventListener('abort', () => { for (const id of active.keys()) end(id); }, { once: true });
  async function pulse(chatId, entry) {
    let delay = initial;
    try {
      while (!entry.signal.aborted) {
        await sleep(delay, undefined, { signal: entry.signal, ref: false });
        entry.signal.throwIfAborted();
        const started = performance.now();
        try {
          await send({ chatId }, entry.signal);
          delay = Math.max(0, refresh - (performance.now() - started));
        } catch {
          // Old bridges, offline connectors and rate limits are best effort.
          delay = backoff;
        }
      }
    } catch {
      // The job stopped before the next pulse.
    } finally {
      if (active.get(chatId) === entry) active.delete(chatId);
    }
  }
  return {
    begin(chatId) {
      if (signal.aborted || active.has(chatId) || active.size >= limit) return;
      const entry = new AbortController();
      active.set(chatId, entry);
      void pulse(chatId, entry);
    },
    end,
  };
}
