import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const KEY = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_MS = 15_000; // Includes the relay's up-to-8-second long poll.
const DRAIN_MS = 250;
const OUTPUT_LIMIT = 8_000;
const STATE_FILE = 'pairing.json';
const SHELL_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];

// Only locally authored, secret-free diagnostics may reach the terminal.
class CompanionError extends Error {}
class RevokedError extends CompanionError {
  constructor() { super('Runtime key rejected (HTTP 401); stopping. Pair again to reconnect.'); }
}

function relayOrigin(input) {
  let url;
  try { url = new URL(input); } catch { /* handled below */ }
  if (!url || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new CompanionError('Provide a relay origin without credentials, path, query, or fragment.');
  }
  if (url.protocol === 'https:') {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      throw new CompanionError('HTTPS relay certificate verification must be enabled.');
    }
    return url.origin;
  }
  if (url.protocol === 'http:' && process.env.MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP === '1' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  throw new CompanionError('The runtime relay requires HTTPS (MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP=1 permits loopback IPs for tests only).');
}

async function post(origin, operation, body, { key, signal, timeout = REQUEST_MS } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  let response;
  try {
    response = await fetch(`${origin}/v1/runtime/${operation}`, {
      method: 'POST',
      redirect: 'error', // Never forward either enrollment secrets or the bearer to another URL.
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch {
    throw new CompanionError(`Runtime ${operation} request failed.`);
  }
  const needsJson = operation !== 'result';
  if ((needsJson && response.status !== 200) || (!needsJson && !response.ok)) {
    await response.body?.cancel().catch(() => {});
    if (key && response.status === 401) throw new RevokedError();
    throw new CompanionError(`Runtime ${operation} rejected (HTTP ${response.status}).`);
  }
  if (!needsJson) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let json = '';
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error();
      json += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } catch {
    throw new CompanionError(`Invalid runtime ${operation} response.`);
  }
}

async function readCode() {
  const terminal = process.stdin.isTTY === true;
  // A raw-mode readline prompt with its echo discarded, or one line from a pipe.
  const output = terminal ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : undefined;
  const lines = createInterface({ input: process.stdin, output, terminal, crlfDelay: Infinity });
  if (terminal) process.stderr.write('Pairing code: ');
  try {
    for await (const line of lines) {
      const code = line.trim();
      if (code) return code;
      break;
    }
    throw new CompanionError('A pairing code is required on stdin.');
  } finally {
    lines.close();
    if (terminal) process.stderr.write('\n');
  }
}

async function saveState(directory, state) {
  const temporary = join(directory, `.pairing-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(JSON.stringify(state) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, STATE_FILE));
  } catch {
    throw new CompanionError('Could not save private runtime state.');
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => {});
  }
}

async function loadState(directory) {
  let state;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const file = await open(join(directory, STATE_FILE), flags);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
        throw new Error();
      }
      state = JSON.parse(await file.readFile('utf8'));
      if (typeof state?.key !== 'string' || !KEY.test(state.key) || typeof state.origin !== 'string') throw new Error();
    } finally {
      await file.close();
    }
  } catch {
    throw new CompanionError('Cannot read private runtime state. Pair first and keep the state file private.');
  }
  return { key: state.key, origin: relayOrigin(state.origin) };
}

async function pair(directory, originInput, name) {
  const origin = relayOrigin(originInput);
  const code = await readCode();
  const key = randomBytes(32).toString('base64url');
  const paired = await post(origin, 'enroll', { code, name, key });
  if (typeof paired?.id !== 'string' || !paired.id || typeof paired.name !== 'string') {
    throw new CompanionError('Invalid runtime enroll response.');
  }
  await saveState(directory, { key, origin });
  console.error('Runtime paired.');
}

function pollJob(response) {
  const job = response?.job;
  if (job === null) return null;
  if (typeof job?.id !== 'string' || !UUID.test(job.id) ||
      typeof job.command !== 'string' || !job.command.trim() || job.command.length > 8000 || job.command.includes('\0') ||
      (job.cwd !== undefined && (typeof job.cwd !== 'string' || !job.cwd || job.cwd.length > 4096 || job.cwd.includes('\0'))) ||
      !Number.isInteger(job.timeoutMs) || job.timeoutMs < 1000 || job.timeoutMs > 120_000) {
    throw new CompanionError('Invalid runtime poll response.');
  }
  return job;
}

function execute({ id, command, cwd = '', timeoutMs }, home, signal) {
  let child;
  try {
    // Environment filtering is not isolation: jobs run with the companion user's filesystem access.
    const env = { HOME: home };
    for (const name of SHELL_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    child = spawn('/bin/bash', ['-c', command], {
      cwd: isAbsolute(cwd) ? cwd : resolve(home, cwd),
      detached: true, // A new process group allows terminating ordinary descendants with the shell.
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return { id, exitCode: null, output: '', timedOut: false };
  }

  return new Promise(resolveResult => {
    let exitCode = null;
    let output = '';
    let timedOut = false;
    let stopping = false;
    let settled = false;
    let drain;
    const timer = setTimeout(() => stop(true), timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      signal.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolveResult({ id, exitCode, output, timedOut });
    }

    function stop(timeout) {
      if (settled || stopping) return;
      stopping = true;
      timedOut = timeout;
      clearTimeout(timer);
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
      drain ??= setTimeout(finish, DRAIN_MS);
    }
    function onAbort() { stop(false); }

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => { output = (output + chunk).slice(-OUTPUT_LIMIT); });
      stream.on('error', () => {});
    }
    child.once('error', finish);
    child.once('exit', code => {
      exitCode = code;
      clearTimeout(timer);
      // A surviving descendant may own a pipe. Don't wait indefinitely for 'close'.
      drain ??= setTimeout(finish, DRAIN_MS);
    });
    child.once('close', finish);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function run(directory, home) {
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const { key, origin } = await loadState(directory);
    let backoff = 0;
    while (!signal.aborted) {
      let job;
      try {
        job = pollJob(await post(origin, 'poll', {}, { key, signal }));
        backoff = 0;
      } catch (error) {
        if (error instanceof RevokedError) throw error;
        if (signal.aborted) break;
        if (backoff === 0) console.error('Runtime poll failed; retrying.');
        backoff = backoff ? Math.min(backoff * 2, 8_000) : 500;
        await sleep(backoff, undefined, { signal }).catch(() => {});
        continue;
      }
      if (signal.aborted) break;
      if (!job) {
        // The relay usually waits; still avoid spinning if it returns null immediately.
        await sleep(100, undefined, { signal }).catch(() => {});
        continue;
      }
      const result = await execute(job, home, signal);
      try {
        // A stopped job gets one brief best-effort report, never a resend.
        const options = signal.aborted ? { key, timeout: 2_000 } : { key, signal };
        await post(origin, 'result', result, options);
      } catch (error) {
        if (error instanceof RevokedError) throw error;
        if (!signal.aborted) console.error('Runtime result delivery failed; not retrying.');
      }
    }
  } catch (error) {
    if (!(error instanceof RevokedError)) throw error;
    console.error(error.message); // Clean exit, so a supervisor need not restart a revoked runtime.
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (process.platform !== 'linux') throw new CompanionError('The runtime companion currently supports Linux only.');
  const home = homedir();
  const directory = process.env.MANOLO_RUNTIME_STATE || join(home, '.local', 'state', 'manolo-runtime');
  if (action === 'pair' && args.length === 2 && args[1].trim()) return pair(directory, ...args);
  if (action === 'run' && args.length === 0) return run(directory, home);
  throw new CompanionError('Usage: node src/runtime-companion.mjs pair <origin> <name> (code on stdin), or node src/runtime-companion.mjs run');
}

main().catch(error => {
  console.error(error instanceof CompanionError ? error.message : 'Runtime companion failed.');
  process.exitCode = 1;
});
