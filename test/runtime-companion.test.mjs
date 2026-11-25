import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/runtime-companion.mjs', import.meta.url));
const code = Buffer.alloc(32, 11).toString('base64url');
const options = { skip: process.platform !== 'linux', timeout: 10_000 };

async function fixture(t, handler) {
  const home = await mkdtemp(join(tmpdir(), 'manolo-runtime-'));
  const state = join(home, 'custom-state');
  const defaultState = join(home, '.local', 'state', 'manolo-runtime');
  const requests = [];
  const children = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = {
        path: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      requests.push(request);
      const reply = await handler(request, requests);
      if (!reply) return; // Leave a long poll open for cancellation tests.
      const [status, body, headers] = reply;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map(({ done }) => done));
    server.close();
    server.closeAllConnections();
    await rm(home, { force: true, recursive: true });
    assert.deepEqual(errors, []);
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  function cli(args, { input, env } = {}) {
    const child = spawn(process.execPath, [script, ...args], {
      env: { HOME: home, PATH: process.env.PATH, MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP: '1', MANOLO_RUNTIME_STATE: state, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const done = once(child, 'close').then(([status, signal]) => ({ status, signal, stdout, stderr }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    done.then(() => clearTimeout(timer), () => clearTimeout(timer));
    children.push({ child, done });
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // Expected if CLI rejects arguments before reading stdin.
      child.stdin.end(input);
    }
    return { child, done };
  }

  async function pair(env) {
    const result = await cli(['pair', origin, 'beast'], { input: `${code}\n`, env }).done;
    assert.equal(result.status, 0, result.stderr);
    const enroll = requests.find(request => request.path === '/v1/runtime/enroll');
    const { key } = enroll.body;
    assert.deepEqual(enroll, {
      path: '/v1/runtime/enroll', method: 'POST', contentType: 'application/json', authorization: undefined, body: { code, name: 'beast', key },
    });
    assert.match(key, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(Buffer.from(key, 'base64url').length, 32);
    assert.notEqual(key, code);
    assertSecretFree(result, code, key);
    return key;
  }

  return { home, state, defaultState, origin, requests, cli, pair };
}

const enrolled = [200, { id: 'companion-1', name: 'beast' }];
const route = action => `/v1/runtime/${action}`;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const replyJob = job => [200, { job }];
const accept = [204];
const unauthorized = [401, { error: 'test relay' }];

function assertSecretFree({ stdout, stderr }, ...secrets) {
  for (const secret of secrets) assert.equal((stdout + stderr).includes(secret), false);
}

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('Timed out waiting for test condition');
}

async function fileIfPresent(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function alive(pid) {
  const stat = await fileIfPresent(`/proc/${pid}/stat`);
  // A killed orphan may be a zombie briefly (or indefinitely under a non-reaping PID 1).
  return !!stat && stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
}

function assertRequest(request, operation, key, body) {
  assert.deepEqual(request, {
    path: route(operation), method: 'POST', contentType: 'application/json', authorization: `Bearer ${key}`, body,
  });
}

test('pairs on stdin, persists restricted state, and executes authenticated jobs using home and a clean environment', options, async t => {
  const firstCommand = '[[ -z ${EXAMPLE_LAUNCHER_SECRET+x}${BASH_ENV+x}${NODE_OPTIONS+x}${MANOLO_RUNTIME_STATE+x} ]] || exit 90; printf "%s\\n" "$PWD"; printf stderr-marker >&2; exit 7';
  const secondCommand = 'printf "%s\\n" "$PWD"; printf "%s" "$HOME"';
  const absoluteCommand = 'pwd';
  const tail = '界😀'.repeat(4_000) + 'tail-marker';
  const lastCommand = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("界😀".repeat(4000) + "tail-marker")'`;
  const jobs = [
    null,
    { id: id(1), command: firstCommand, cwd: 'project', timeoutMs: 1_000 },
    { id: id(2), command: secondCommand, timeoutMs: 120_000 },
    { id: id(3), command: absoluteCommand, cwd: '/tmp', timeoutMs: 3_000 },
    { id: id(4), command: lastCommand, timeoutMs: 3_000 },
    { id: id(5), command: 'printf must-not-run', cwd: 'missing', timeoutMs: 3_000 },
    { id: id(6), command: 'id -u; env', timeoutMs: 3_000 },
  ];
  const f = await fixture(t, ({ path }, requests) => {
    if (path === route('enroll')) return enrolled;
    if (path === route('poll')) {
      const i = requests.filter(request => request.path === path).length - 1;
      return i < jobs.length ? replyJob(jobs[i]) : unauthorized;
    }
    assert.equal(path, route('result'));
    return accept;
  });
  const project = join(f.home, 'project');
  await mkdir(project);
  const key = await f.pair();
  const stateFile = join(f.state, 'pairing.json');
  assert.equal((await stat(f.state)).mode & 0o777, 0o700);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { origin: f.origin, key });
  const run = await f.cli(['run'], { env: {
    EXAMPLE_LAUNCHER_SECRET: 'launcher-secret-marker', BASH_ENV: '/unexpected-launcher-script', NODE_OPTIONS: '--no-warnings',
  } }).done;
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /HTTP 401.*stopping/i);
  assertSecretFree(run, key, code, 'launcher-secret-marker', 'stderr-marker', 'tail-marker', secondCommand);
  const polls = f.requests.filter(request => request.path === route('poll'));
  assert.equal(polls.length, jobs.length + 1);
  for (const poll of polls) assertRequest(poll, 'poll', key, {});
  const results = f.requests.filter(request => request.path === route('result'));
  assert.equal(results.length, jobs.length - 1);
  const combined = results[0].body.output;
  assert.ok(combined === `${project}\nstderr-marker` || combined === `stderr-marker${project}\n`);
  assertRequest(results[0], 'result', key, { id: id(1), exitCode: 7, output: combined, timedOut: false });
  assertRequest(results[1], 'result', key, { id: id(2), exitCode: 0, output: `${f.home}\n${f.home}`, timedOut: false });
  assertRequest(results[2], 'result', key, { id: id(3), exitCode: 0, output: '/tmp\n', timedOut: false });
  assertRequest(results[3], 'result', key, { id: id(4), exitCode: 0, output: tail.slice(-8000), timedOut: false });
  assertRequest(results[4], 'result', key, { id: id(5), exitCode: null, output: '', timedOut: false });
  const environment = results[5].body.output;
  assertRequest(results[5], 'result', key, { id: id(6), exitCode: 0, output: environment, timedOut: false });
  assert.equal(environment.split('\n')[0], String(process.getuid()));
  assert.ok(environment.split('\n').includes(`HOME=${f.home}`));
  assert.equal(environment.includes(key), false, 'the same-account shell must not inherit the actual paired bearer');
  assert.doesNotMatch(environment, /launcher-secret-marker|MANOLO_RUNTIME_STATE|MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP/);
});

test('requires HTTPS by default, does not forward enrollment through redirects, and refuses exposed local state', options, async t => {
  let redirect = true;
  const f = await fixture(t, () => redirect ? [307, undefined, { location: '/must-not-follow' }] : enrolled);
  const rejected = await f.cli(['pair', f.origin, 'beast'], { input: code, env: { MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP: '' } }).done;
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /requires HTTPS/);
  assert.equal(f.requests.length, 0);
  const remote = await f.cli(['pair', 'http://192.0.2.42', 'beast'], { input: code }).done;
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /requires HTTPS/);
  const redirected = await f.cli(['pair', f.origin, 'beast'], { input: code }).done;
  assert.equal(redirected.status, 1);
  assert.deepEqual(f.requests.map(({ path }) => path), [route('enroll')]);
  assertSecretFree(redirected, code, f.requests[0].body.key);
  await assert.rejects(stat(f.state), { code: 'ENOENT' });

  redirect = false;
  f.requests.length = 0;
  const env = { MANOLO_RUNTIME_STATE: '' };
  const key = await f.pair(env);
  const stateFile = join(f.defaultState, 'pairing.json');
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  const insecure = await f.cli(['run'], { env: { ...env, MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP: '' } }).done;
  assert.equal(insecure.status, 1);
  assert.match(insecure.stderr, /requires HTTPS/);
  assertSecretFree(insecure, key);
  await chmod(stateFile, 0o644);
  const unsafe = await f.cli(['run'], { env }).done;
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /private runtime state/);
  assertSecretFree(unsafe, key);
  assert.deepEqual(f.requests.map(({ path }) => path), [route('enroll')]);
});

test('recovers transient poll errors, does not retry a failed result, and stops on result 401', options, async t => {
  const job = (n, output) => ({ id: id(n), command: `printf ${output}`, timeoutMs: 3_000 });
  const script = [enrolled, [503], replyJob(job(1, 'one')), [503], replyJob(job(2, 'two')), unauthorized];
  const f = await fixture(t, (_, requests) => {
    assert.ok(requests.length <= script.length, 'must stop polling on a result 401');
    return script[requests.length - 1];
  });
  const key = await f.pair();
  const run = await f.cli(['run']).done;
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /poll failed; retrying/);
  assert.match(run.stderr, /result delivery failed; not retrying/);
  assert.match(run.stderr, /HTTP 401.*stopping/);
  assert.deepEqual(f.requests.map(({ path }) => path), ['enroll', 'poll', 'poll', 'result', 'poll', 'result'].map(route));
  assertRequest(f.requests[3], 'result', key, { id: id(1), exitCode: 0, output: 'one', timedOut: false });
  assertRequest(f.requests[5], 'result', key, { id: id(2), exitCode: 0, output: 'two', timedOut: false });
});

test('rejects malformed or oversized jobs before spawning a shell', { ...options, concurrency: true }, async t => {
  const valid = { id: id(1), command: 'printf should-not-run', timeoutMs: 3_000 };
  const cases = [
    ['id is not a UUID', { id: 'not-a-uuid' }],
    ['command is blank', { command: ' \t' }],
    ['command exceeds 8000 code units', { command: 'x'.repeat(8_001) }],
    ['command contains NUL', { command: `${valid.command}\0` }],
    ['cwd is empty', { cwd: '' }],
    ['cwd exceeds 4096 code units', { cwd: 'x'.repeat(4_097) }],
    ['cwd contains NUL', { cwd: '.\0' }],
    ['timeout is below 1000', { timeoutMs: 999 }],
    ['timeout exceeds 120000', { timeoutMs: 120_001 }],
    ['timeout is not an integer', { timeoutMs: 1000.5 }],
  ];
  await Promise.all(cases.map(([name, fields]) => t.test(name, async t => {
    const f = await fixture(t, ({ path }, requests) => {
      if (path === route('enroll')) return enrolled;
      assert.equal(path, route('poll'), 'invalid jobs must not produce results');
      return requests.length === 2 ? replyJob({ ...valid, ...fields }) : unauthorized;
    });
    await f.pair();
    const run = await f.cli(['run']).done;
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /poll failed; retrying/);
    assert.deepEqual(f.requests.map(({ path }) => path), ['enroll', 'poll', 'poll'].map(route));
  })));
});

test('SIGTERM cancels an in-flight idle long poll', options, async t => {
  const f = await fixture(t, ({ path }) => path === route('enroll') ? enrolled : undefined);
  const key = await f.pair();
  const run = f.cli(['run']);
  await until(() => f.requests.length === 2);
  assertRequest(f.requests[1], 'poll', key, {});
  assert.equal(run.child.kill('SIGTERM'), true);
  const result = await run.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.requests.length, 2);
});

for (const stop of ['timeout', 'SIGTERM']) {
  test(`${stop} kills the Linux shell and its process group`, options, async t => {
    const command = 'sleep 60 & printf started; printf "%s %s\\n" "$$" "$!" > pids; wait';
    const f = await fixture(t, ({ path }, requests) => {
      if (path === route('enroll')) return enrolled;
      if (path === route('result')) return accept;
      return requests.filter(request => request.path === path).length === 1
        ? replyJob({ id: id(1), command, timeoutMs: stop === 'timeout' ? 1_000 : 60_000 }) : unauthorized;
    });
    const key = await f.pair();
    const run = f.cli(['run']);
    const pids = await until(async () => /^(\d+) (\d+)\n$/.exec(await fileIfPresent(join(f.home, 'pids')))?.slice(1).map(Number));
    assert.equal(pids.length, 2);
    assert.ok(pids.every(pid => Number.isInteger(pid) && pid > 1));
    t.after(() => { try { process.kill(-pids[0], 'SIGKILL'); } catch { /* already gone */ } });
    assert.equal(await alive(pids[1]), true);
    if (stop === 'SIGTERM') assert.equal(run.child.kill('SIGTERM'), true);
    const result = await run.done;
    assert.equal(result.status, 0, result.stderr);
    const delivered = f.requests.filter(request => request.path === route('result'));
    assert.equal(delivered.length, 1);
    assertRequest(delivered[0], 'result', key, { id: id(1), exitCode: null, output: 'started', timedOut: stop === 'timeout' });
    await until(async () => !(await alive(pids[0])) && !(await alive(pids[1])));
  });
}

test('reports a successful shell exit without hanging on a descendant holding its pipes open', options, async t => {
  const command = 'sleep 60 & printf "%s\\n" "$!" > descendant; printf done';
  const f = await fixture(t, ({ path }, requests) => {
    if (path === route('enroll')) return enrolled;
    if (path === route('result')) return accept;
    return requests.filter(request => request.path === path).length === 1
      ? replyJob({ id: id(1), command, timeoutMs: 60_000 }) : unauthorized;
  });
  const key = await f.pair();
  const run = f.cli(['run']);
  const pid = await until(async () => Number(/^(\d+)\n$/.exec(await fileIfPresent(join(f.home, 'descendant')))?.[1]));
  assert.ok(Number.isInteger(pid) && pid > 1);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  const result = await run.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await alive(pid), true, 'normal completion does not terminate background jobs');
  const delivered = f.requests.find(request => request.path === route('result'));
  assertRequest(delivered, 'result', key, { id: id(1), exitCode: 0, output: 'done', timedOut: false });
});
