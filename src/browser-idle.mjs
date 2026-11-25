import { readdir, readFile } from 'node:fs/promises';

// A headed Chromium keeps a large part of its heap mapped long after the agent stopped using it, and the sidecar has
// its own 2Gi limit. Nothing else in the pod needs that memory, so after an idle window the worker terminates the
// sidecar container's main process; the kubelet restarts only that container and `--restore-last-session` brings the
// tabs back on the next use. This file owns the one decision (is it idle?) and the one effect (SIGTERM the sibling).
const MAX_PROCS = 4096;
const TICK_MS = 30_000;
// jlesage's image runs /init (a shell script) which execs tini, which runs startapp.sh. Matching the supervisor and
// not the browser's own children is deliberate: Chromium's command line names the profile, not the container init.
const SUPERVISOR = /(^|\/)(init|tini)$/;
const JLESAGE = /jlesage|startapp/;

const isSupervisor = cmdline => {
  const argv = cmdline.split('\0').filter(Boolean);
  if (argv.length === 0) return false;
  if (SUPERVISOR.test(argv[0])) return true;
  return argv.some(argument => JLESAGE.test(argument));
};

// A cgroup file is `<hierarchy>:<controllers>:<path>` per line (v2 has one line). The container is the last segment.
const cgroupPaths = text => String(text).split('\n').map(line => line.trim()).filter(Boolean)
  .map(line => line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1))
  .filter(path => path !== '' && path !== '/');
const parentOf = path => path.slice(0, path.lastIndexOf('/'));

/**
 * Heuristically finds the Chromium sidecar's main process. With `shareProcessNamespace: true` the worker sees the
 * sibling container's processes, so a pid is a candidate only when its cgroup is a *different container under the
 * same pod parent* and its command line looks like the image's supervisor.
 *
 * This is a heuristic, not a proof: another container in the same pod that runs `init`/`tini` would also match, and a
 * pod that does not share its PID namespace finds nothing. The same-pod-parent rule is what keeps a workstation (where
 * every podman/docker container has its own unrelated cgroup) from looking like a sibling. Both readers are injectable
 * so the decision is testable without real containers; unreadable pids (exited, or hidden by hidepid) are skipped.
 */
export async function findSidecarBrowserPid({ readDir = readdir, readFile: read = readFile } = {}) {
  const self = process.pid;
  let ownPaths;
  try { ownPaths = cgroupPaths(await read(`/proc/${self}/cgroup`, 'utf8')); } catch { return undefined; }
  // Every container of one pod lives under the same parent with the container id as the last segment. Without such
  // a parent there is no way to tell a sibling container from an unrelated process, so we refuse to guess.
  const podParents = new Set(ownPaths.map(parentOf));
  if (podParents.size === 0) return undefined;
  let names;
  try { names = await readDir('/proc'); } catch { return undefined; }
  const pids = names
    .filter(name => /^\d{1,10}$/.test(name))
    .map(Number)
    .filter(pid => pid > 1 && pid !== self)
    .sort((left, right) => left - right)
    .slice(0, MAX_PROCS);
  for (const pid of pids) {
    let cmdline;
    try { cmdline = String(await read(`/proc/${pid}/cmdline`, 'utf8')); } catch { continue; }
    if (!isSupervisor(cmdline)) continue;
    let paths;
    try { paths = cgroupPaths(await read(`/proc/${pid}/cgroup`, 'utf8')); } catch { continue; }
    // The same cgroup means the worker's own container; its init must never be the one we stop.
    if (paths.some(path => ownPaths.includes(path))) continue;
    if (!paths.some(path => podParents.has(parentOf(path)))) continue;
    return pid;
  }
  return undefined;
}

/**
 * Decides whether the browser has been idle for long enough and, once per idle window, stops its container.
 *
 * `check()` is the whole decision and effect. It is asynchronous because finding the sidecar reads /proc, so a test
 * drives it with a fake clock and awaits it; `state()` reports the last decision without doing anything. `touch()`
 * records activity from a browser tool call or from a person watching the desktop, and re-arms the window after a stop
 * because the container is running again. A timer only calls `check()`; it never keeps the process alive.
 */
export function createBrowserIdle({ idleMs, now = Date.now, findBrowserPid, kill = process.kill, log = console, tickMs = TICK_MS } = {}) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 0) {
    throw new Error('The browser idle timeout must be a non-negative integer of milliseconds');
  }
  if (typeof findBrowserPid !== 'function') throw new Error('The browser idle watcher needs a way to find the sidecar process');
  let lastTouch = now();
  // One stop per idle window: a second tick must not signal the same pid, or log again, before a real touch.
  let stopped = false;
  let current = idleMs === 0 ? 'disabled' : 'active';
  const say = (level, message) => {
    try { log[level]?.(message); } catch { /* a logger must never break the tick */ }
  };

  async function check() {
    if (idleMs === 0) return (current = 'disabled');
    if (stopped) return (current = 'stopped');
    if (now() - lastTouch < idleMs) return (current = 'active');
    current = 'idle';
    let pid;
    // Reading /proc takes a moment; a tool call or a viewer can arrive while it runs, so the decision is taken again
    // afterwards. Everything below the second check is synchronous, so two ticks cannot both signal the same pid.
    try { pid = await findBrowserPid(); } catch { pid = undefined; }
    if (stopped) return (current = 'stopped');
    const idle = now() - lastTouch;
    if (idle < idleMs) return (current = 'active');
    // No pid is expected while the container is restarting; the next tick simply tries again.
    if (!Number.isSafeInteger(pid) || pid <= 1) return current;
    stopped = true;
    current = 'stopped';
    const minutes = Math.max(1, Math.round(idle / 60_000));
    try {
      kill(pid, 'SIGTERM');
      say('log', `Browser idle for ${minutes} minutes; stopping its container to free memory`);
    } catch {
      // The container may already be gone, or the sandbox may forbid the signal. Report it once and stay quiet:
      // a stop that keeps failing is an operator problem, not something to retry every tick.
      say('error', `Could not stop the idle browser container after ${minutes} minutes`);
    }
    return current;
  }

  let timer;
  if (idleMs > 0 && tickMs > 0) {
    timer = setInterval(() => { check().catch(() => { /* a tick must never become an unhandled rejection */ }); }, tickMs);
    timer.unref?.();
  }

  return {
    touch() {
      lastTouch = now();
      stopped = false;
      // `touch()` on a disabled watcher changes nothing; there is no window to re-arm.
      if (idleMs > 0) current = 'active';
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    state: () => current,
    check,
  };
}
