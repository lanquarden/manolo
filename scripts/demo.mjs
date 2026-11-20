import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'manolo-demo-'));
const children = [];
const secret = () => randomBytes(24).toString('hex');
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const primary = secret();
const canary = secret();
const owner = 'owner';
const tester = 'tester';
const config = join(root, 'relay.json');
const host = '127.0.0.1';
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const active = children.filter(p => p.exitCode === null && p.signalCode === null);
  const waits = active.map(p => once(p, 'exit'));
  for (const p of active) p.kill('SIGTERM');
  await Promise.allSettled(waits);
  await rm(root, { recursive: true, force: true });
}

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
function run(entry, vars) {
  const p = spawn(process.execPath, [`src/${entry}.mjs`], {
    cwd: new URL('../', import.meta.url), env: { ...env, HOST: host, ...vars }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(p);
  p.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${entry} stopped unexpectedly (${code ?? signal})`);
      process.exitCode = 1;
      void stop();
    }
  });
  return p;
}

function ready(p, pattern) {
  const signal = AbortSignal.timeout(15_000);
  return new Promise((resolve, reject) => {
    let out = '';
    signal.addEventListener('abort', () => reject(new Error('Manolo demo did not start')), { once: true });
    p.once('error', reject);
    p.once('exit', () => reject(new Error('Manolo demo process stopped')));
    p.stdout.on('data', chunk => {
      out += chunk;
      const found = pattern.exec(out);
      if (found) resolve(Number(found[1]));
    });
  });
}

try {
  const agents = {};
  for (const [id, token, tokenEnv] of [['primary', primary, 'PRIMARY_TOKEN'], ['canary', canary, 'CANARY_TOKEN']]) {
    const p = run('worker', { MANOLO_AGENT_ID: id, MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: join(root, id), MANOLO_MODE: 'fixture', PORT: '0' });
    agents[id] = { url: `http://${host}:${await ready(p, /worker listening on (\d+)/)}`, tokenEnv };
  }
  await writeFile(config, JSON.stringify({
    agents, owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' }, tester: { agent: 'canary', passwordEnv: 'TESTER_PASSWORD' } },
    routes: [], inbox: [{ from: 'primary', to: 'canary' }],
  }));
  const relay = run('relay', {
    MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: join(root, 'relay'), MANOLO_DEMO: '1',
    PRIMARY_TOKEN: primary, CANARY_TOKEN: canary, OWNER_PASSWORD: owner, TESTER_PASSWORD: tester,
    PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  const port = await ready(relay, /web listening on .*:(\d+)/);
  console.log(`Manolo offline demo: http://${host}:${port}\nowner / ${owner}\ntester / ${tester}\nTemporary logins and state are removed at exit. Ctrl+C to stop.`);
} catch (error) {
  if (!stopping) { console.error(error.message); process.exitCode = 1; }
  await stop();
}
