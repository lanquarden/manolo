import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBrowserIdle, findSidecarBrowserPid } from '../src/browser-idle.mjs';

const MINUTE = 60_000;

// The decision is `now() - lastTouch`, so a test drives a fake clock instead of waiting ten real minutes.
function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance(ms) { value += ms; } };
}

function watcher(t, { idleMs = 10 * MINUTE, pids = [4321], kill, log = { log() {}, error() {} } } = {}) {
  const time = clock();
  const calls = [];
  const idle = createBrowserIdle({
    idleMs, now: time.now, tickMs: 0, log, kill: kill ?? ((pid, signal) => calls.push([pid, signal])),
    findBrowserPid: typeof pids === 'function' ? pids : () => pids[0],
  });
  t.after(() => idle.stop());
  return { idle, time, calls };
}

test('a touch inside the window keeps the browser active', async t => {
  const { idle, time, calls } = watcher(t);
  assert.equal(idle.state(), 'active');
  time.advance(9 * MINUTE);
  assert.equal(await idle.check(), 'active');
  idle.touch();
  time.advance(9 * MINUTE);
  assert.equal(await idle.check(), 'active');
  assert.deepEqual(calls, []);
});

test('crossing the window stops the container once with SIGTERM and logs one line', async t => {
  const lines = [];
  const { idle, time, calls } = watcher(t, { log: { log: line => lines.push(line), error: () => assert.fail('no failure') } });
  time.advance(10 * MINUTE);
  assert.equal(await idle.check(), 'stopped');
  assert.deepEqual(calls, [[4321, 'SIGTERM']]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Browser idle for 10 minutes; stopping its container to free memory/);
  // The same idle window must never signal twice, however many ticks pass.
  time.advance(60 * MINUTE);
  assert.equal(await idle.check(), 'stopped');
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 1);
});

test('touch re-arms the window so the restarted container can be stopped again', async t => {
  const { idle, time, calls } = watcher(t);
  time.advance(10 * MINUTE);
  assert.equal(await idle.check(), 'stopped');
  idle.touch();
  assert.equal(idle.state(), 'active');
  time.advance(10 * MINUTE);
  assert.equal(await idle.check(), 'stopped');
  assert.deepEqual(calls, [[4321, 'SIGTERM'], [4321, 'SIGTERM']]);
});

test('a missing sidecar process is not an error and is retried on the next check', async t => {
  const lines = [];
  const time = clock();
  const calls = [];
  // The container is still starting: the first check finds nothing, the second finds it.
  const pids = [undefined, 987];
  const idle = createBrowserIdle({
    idleMs: 5 * MINUTE, now: time.now, tickMs: 0, findBrowserPid: () => pids.shift(),
    kill: (pid, signal) => calls.push([pid, signal]), log: { log: line => lines.push(line), error: () => assert.fail('no failure') },
  });
  t.after(() => idle.stop());
  time.advance(5 * MINUTE);
  assert.equal(await idle.check(), 'idle');
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, []);
  assert.equal(await idle.check(), 'stopped');
  assert.deepEqual(calls, [[987, 'SIGTERM']]);
  assert.equal(lines.length, 1);
});

test('pid 1 and a broken finder are never signalled', async t => {
  const { idle, time, calls } = watcher(t, { pids: () => [1] });
  time.advance(10 * MINUTE);
  assert.equal(await idle.check(), 'idle');
  assert.deepEqual(calls, []);
  const time2 = clock();
  const throwing = createBrowserIdle({
    idleMs: MINUTE, now: time2.now, tickMs: 0, findBrowserPid: () => { throw new Error('procfs went away'); },
    kill: () => assert.fail('must not kill'), log: { log() {}, error() {} },
  });
  t.after(() => throwing.stop());
  time2.advance(MINUTE);
  assert.equal(await throwing.check(), 'idle');
});

test('a touch that arrives during the process scan keeps the browser alive', async t => {
  // Reading /proc is asynchronous, so a tool call can land while the scan runs. The decision is retaken afterwards.
  const time = clock();
  const calls = [];
  let found;
  const idle = createBrowserIdle({
    idleMs: MINUTE, now: time.now, tickMs: 0, kill: pid => calls.push(pid),
    findBrowserPid: () => new Promise(resolve => { found = resolve; }),
    log: { log() {}, error() {} },
  });
  t.after(() => idle.stop());
  time.advance(2 * MINUTE);
  const pending = idle.check();
  idle.touch();
  found(1234);
  assert.equal(await pending, 'active');
  assert.deepEqual(calls, []);
});

test('idleMs 0 disables the watcher entirely', async t => {
  const calls = [];
  const { idle, time } = watcher(t, { idleMs: 0, pids: () => [4321], kill: (pid) => calls.push(pid) });
  assert.equal(idle.state(), 'disabled');
  time.advance(24 * 60 * MINUTE);
  assert.equal(await idle.check(), 'disabled');
  idle.touch();
  assert.equal(idle.state(), 'disabled');
  assert.deepEqual(calls, []);
});

test('a failing kill is swallowed and logged once', async t => {
  const errors = [];
  const { idle, time } = watcher(t, {
    kill: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    log: { log: () => assert.fail('not a clean stop'), error: line => errors.push(line) },
  });
  time.advance(10 * MINUTE);
  assert.equal(await idle.check(), 'stopped');
  assert.equal(await idle.check(), 'stopped');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Could not stop the idle browser container/);
});

test('the timer checks on its own and stop() ends it', async t => {
  const time = clock();
  const calls = [];
  const idle = createBrowserIdle({
    idleMs: 1, now: time.now, tickMs: 10, findBrowserPid: () => 321, kill: pid => calls.push(pid),
    log: { log() {}, error() {} },
  });
  t.after(() => idle.stop());
  time.advance(2);
  for (let attempt = 0; attempt < 100 && calls.length === 0; attempt++) await sleep(5);
  assert.deepEqual(calls, [321]);
  idle.stop();
  idle.touch();
  time.advance(60_000);
  await sleep(40);
  assert.equal(calls.length, 1);
});

test('the sidecar process is found only outside the worker’s own container and by its supervisor', async () => {
  const self = String(process.pid);
  const files = {
    [`/proc/${self}/cgroup`]: '0::/kubepods/besteffort/pod-uid-a/worker\n',
    '/proc/1/cmdline': '/pause\0',
    '/proc/1/cgroup': '0::/kubepods/besteffort/pod-uid-a/pause\n',
    // Same container as the worker, and it happens to look like a supervisor: never the target.
    '/proc/100/cmdline': '/init\0',
    '/proc/100/cgroup': '0::/kubepods/besteffort/pod-uid-a/worker\n',
    // A different container in this pod but an ordinary process: not the sidecar.
    '/proc/200/cmdline': 'node\0server.js\0',
    '/proc/200/cgroup': '0::/kubepods/besteffort/pod-uid-a/other\n',
    // A supervisor in another pod: a sibling cgroup is not enough, the pod parent must match.
    '/proc/250/cmdline': '/init\0',
    '/proc/250/cgroup': '0::/kubepods/besteffort/pod-uid-b/browser\n',
    // The sidecar's supervisor.
    '/proc/300/cmdline': '/init\0',
    '/proc/300/cgroup': '0::/kubepods/besteffort/pod-uid-a/browser\n',
  };
  const readDir = async () => ['1', self, '100', '200', '250', '300', 'not-a-pid'];
  const readFile = async path => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    return files[path];
  };
  assert.equal(await findSidecarBrowserPid({ readDir, readFile }), 300);

  // tini, startapp.sh and a jlesage path all identify the same image; an unreadable pid is skipped. This also covers
  // the cgroup v1 shape, where one container appears once per controller hierarchy.
  for (const cmdline of ['/sbin/tini\0--\0', '/bin/sh\0/startapp.sh\0', '/opt/jlesage/init\0']) {
    const only = {
      [`/proc/${self}/cgroup`]: '1:name=systemd:/kubepods/pod-uid-c/worker\n0::/kubepods/pod-uid-c/worker\n',
      '/proc/50/cmdline': 'node\0worker.mjs\0',
      '/proc/50/cgroup': '1:name=systemd:/kubepods/pod-uid-c/worker\n0::/kubepods/pod-uid-c/worker\n',
      '/proc/60/cmdline': 'chromium\0--user-data-dir=/config\0',
      '/proc/60/cgroup': '1:name=systemd:/kubepods/pod-uid-c/browser\n0::/kubepods/pod-uid-c/browser\n',
      '/proc/70/cmdline': cmdline,
      '/proc/70/cgroup': '1:name=systemd:/kubepods/pod-uid-c/browser\n0::/kubepods/pod-uid-c/browser\n',
    };
    const read = async path => {
      if (!(path in only)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return only[path];
    };
    assert.equal(await findSidecarBrowserPid({ readDir: async () => [self, '50', '60', '70'], readFile: read }), 70, cmdline);
  }

  // Nothing readable, nothing matching, or no pod-scoped cgroup at all is undefined rather than an error.
  assert.equal(await findSidecarBrowserPid({ readDir: async () => [self], readFile }), undefined);
  assert.equal(await findSidecarBrowserPid({ readDir: async () => { throw new Error('ENOENT'); }, readFile }), undefined);
  const rootCgroup = async path => path === `/proc/${self}/cgroup` ? '0::/\n' : files[path];
  assert.equal(await findSidecarBrowserPid({ readDir, readFile: rootCgroup }), undefined);
});
