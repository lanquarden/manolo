import { Connection, RemoteExecutionEnv, localDaemon, sshConnection } from '@earendil-works/pi-env';
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';

// A workspace target is a machine whose files and shell the agent uses through its ordinary tools, while storage,
// credentials and the conversation stay in the pod. Pi-env supplies the transport: a small daemon over SSH, or over a
// pipe to a daemon on this machine. This is *not* the paired-runtime pilot: `runtime_exec` calls one command through a
// relay-mediated device, while a target replaces the environment `read`, `write`, `edit` and `bash` run in.
export const TARGET_FILE = 'ssh/known_hosts';
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_TARGETS = 8;

export class RemoteEnvError extends Error {}

/** The chosen target of one conversation: empty for the pod, `{ name }` for a configured machine. */
export const WorkspaceTarget = defineDoc({
  kind: 'manolo.workspace-target', scope: 'conversation', version: 1, initial: () => ({}), checkpointWhen: () => true,
});

const text = (value, limit) => ({ type: 'string', minLength: 1, maxLength: limit });

function expand(value, env, label) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g, (whole, name) => {
    const resolved = env[name];
    if (typeof resolved !== 'string' || resolved === '') throw new RemoteEnvError(`remote target references an unset environment variable (${label}): ${name}`);
    return resolved;
  });
}

function string(value, label, { pattern, limit = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) throw new RemoteEnvError(`${label} must be a short string`);
  if (pattern && !pattern.test(value)) throw new RemoteEnvError(`${label} is not valid`);
  return value;
}

// Hosts, users and key aliases are structural, not secret: a reference here would only hide a mistake.
function literal(value, label, options) {
  const text = string(value, label, options);
  if (text.includes('${')) throw new RemoteEnvError(`${label} cannot reference environment variables; only cwd, knownHostsFile and identityFile may`);
  return text;
}

/**
 * `MANOLO_REMOTE_ENVS`: `{ "beast": { "kind": "ssh", "host": "beast", "user": "lanquarden", "knownHostsFile": "...",
 * "hostKeyAlias": "manolo-beast", "cwd": "/home/lanquarden" }, "sandbox": { "kind": "local", "cwd": "/tmp/x" } }`.
 * Strings may reference the worker environment with `${NAME}`.
 */
export function parseRemoteEnvs(value, env = process.env) {
  const targets = new Map();
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return targets;
  if (typeof value !== 'string') throw new RemoteEnvError('MANOLO_REMOTE_ENVS must be JSON text');
  let raw;
  try { raw = JSON.parse(value); } catch { throw new RemoteEnvError('MANOLO_REMOTE_ENVS is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RemoteEnvError('MANOLO_REMOTE_ENVS must be a mapping');
  if (Object.keys(raw).length > MAX_TARGETS) throw new RemoteEnvError(`MANOLO_REMOTE_ENVS may configure at most ${MAX_TARGETS} targets`);
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name)) throw new RemoteEnvError(`Invalid target name: ${String(name).slice(0, 40)}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RemoteEnvError(`Target ${name} must be an object`);
    const kind = entry.kind ?? 'ssh';
    if (kind !== 'ssh' && kind !== 'local') throw new RemoteEnvError(`Target ${name} must have kind ssh or local`);
    const cwd = expand(string(entry.cwd, `${name}.cwd`), env, `${name}.cwd`);
    if (!cwd.startsWith('/')) throw new RemoteEnvError(`Target ${name}.cwd must be an absolute path`);
    if (kind === 'local') {
      targets.set(name, { name, kind, cwd });
      continue;
    }
    const knownHostsFile = expand(string(entry.knownHostsFile, `${name}.knownHostsFile`), env, `${name}.knownHostsFile`);
    if (!knownHostsFile.startsWith('/')) throw new RemoteEnvError(`Target ${name}.knownHostsFile must be an absolute path`);
    const port = entry.port ?? 22;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new RemoteEnvError(`Target ${name}.port must be a TCP port`);
    targets.set(name, {
      name, kind, cwd, host: literal(entry.host, `${name}.host`, { pattern: /^[^@\s]{1,255}$/ }), port, knownHostsFile,
      hostKeyAlias: literal(entry.hostKeyAlias ?? `manolo-${name}`, `${name}.hostKeyAlias`, { pattern: /^[^\s]{1,255}$/ }),
      ...(entry.user !== undefined && { user: literal(entry.user, `${name}.user`, { pattern: /^[^\s@]{1,64}$/ }) }),
      ...(entry.identityFile !== undefined && {
        identityFile: expand(string(entry.identityFile, `${name}.identityFile`), env, `${name}.identityFile`),
      }),
    });
  }
  return targets;
}

/**
 * Lazily connected environments, one per target. `sshConnection` deploys and verifies the daemon on first use; a target
 * whose host key is not trusted fails that operation with pi-env's error instead of connecting anyway.
 */
export function createRemoteTargets({ targets, log = console }) {
  const live = new Map();
  const describe = () => [...targets.values()].map(target => ({ name: target.name, kind: target.kind, cwd: target.cwd }));

  function entry(name, conversationId) {
    const target = targets.get(name);
    if (!target) throw new Error('Unknown workspace target');
    let current = live.get(name);
    if (!current) {
      const connection = target.kind === 'ssh'
        ? sshConnection({
          // The connection needs host, port, user and the trust files; the rest of the target is Manolo's own.
          host: target.host, port: target.port, ...(target.user && { user: target.user }),
          ...(target.identityFile && { identityFile: target.identityFile }),
          knownHostsFile: target.knownHostsFile, hostKeyAlias: target.hostKeyAlias,
        }).connection
        : new Connection({ command: [localDaemon()] });
      current = {
        connection,
        env: new RemoteExecutionEnv({ connection, id: `pi-env:${name}`, cwd: target.cwd }),
      };
      live.set(name, current);
      log.log(`Workspace target ${name} (${target.kind}) is ready for ${conversationId.slice(0, 8)}`);
    }
    return current;
  }

  return {
    names: () => [...targets.keys()],
    has: name => targets.has(name),
    describe,
    envFor: (name, conversationId) => entry(name, conversationId).env,
    close: () => {
      for (const { connection } of live.values()) connection.close();
      live.clear();
    },
  };
}

/**
 * The tools the agent uses to choose. Both write or read a conversation document, which the harness environment factory
 * reads on every use, so the switch applies to later operations in the same conversation without a new turn type.
 */
export function installWorkspaceTools(registry, { targets }) {
  const current = async (api, context) => (await api.snapshot(WorkspaceTarget, api.conversationId, context))?.name;

  const list = defineTool({
    name: 'workspace_targets', callers: ['model'], replay: 'safe',
    description: 'List the machines this conversation can work on, and which one its file and shell tools currently use. The pod is the default.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_args, api, context) {
      const active = await current(api, context);
      const lines = targets.describe().map(target =>
        `${target.name === active ? '*' : ' '} ${target.name} (${target.kind}) ${target.cwd}`);
      return {
        output: [{ type: 'text', text: [`pod${active === undefined ? ' *' : ''}`, ...lines].join('\n') }],
      };
    },
  });

  const use = defineTool({
    name: 'workspace_target', callers: ['model'], replay: 'unsafe',
    description: 'Switch this conversation to a machine from workspace_targets, or back to the pod with "pod". File and shell tools run there from the next call on.',
    parameters: { type: 'object', properties: { name: text(32) }, required: ['name'], additionalProperties: false },
    async execute({ name }, api, context) {
      if (name !== 'pod' && !targets.has(name)) throw new Error('Unknown workspace target');
      await api.commit(async tx => {
        const doc = await tx.doc(WorkspaceTarget, api.conversationId, null);
        if (name === 'pod') delete doc.name;
        else doc.name = name;
      }, context);
      const where = name === 'pod' ? 'the pod' : `${name} (${targets.describe().find(target => target.name === name).cwd})`;
      return { output: [{ type: 'text', text: `This conversation now runs its file and shell tools on ${where}.` }] };
    },
  });

  registry.install(defineExtension({ name: 'manolo-workspace', tools: [list, use] }));
  return { list, use };
}

/**
 * Operator entry point for the SSH side: `list` shows the configured targets, and `trust <name>` prints the host key
 * fingerprints so the owner can compare one out of band before it is written to the target's `knownHostsFile`.
 * Pi-env never accepts a changed key; an unknown one fails every operation until this runs.
 */
async function main(argv) {
  const { scanHostKey, acceptHostKey } = await import('@earendil-works/pi-env');
  const targets = parseRemoteEnvs(process.env.MANOLO_REMOTE_ENVS, process.env);
  const [command, name] = argv;
  if (command === 'list' || command === undefined) {
    for (const target of targets.values()) {
      console.log(`${target.name}\t${target.kind}\t${target.kind === 'ssh' ? `${target.host}:${target.port}` : 'local'}\t${target.cwd}`);
    }
    if (targets.size === 0) console.log('No targets are configured in MANOLO_REMOTE_ENVS.');
    return 0;
  }
  if (command !== 'trust') {
    console.error('Usage: node src/remote-env.mjs [list | trust <name> [--yes]]');
    return 2;
  }
  const target = targets.get(name);
  if (!target || target.kind !== 'ssh') {
    console.error(`Unknown SSH target: ${name ?? '(none)'}`);
    return 2;
  }
  const ssh = {
    host: target.host, port: target.port, ...(target.user && { user: target.user }),
    ...(target.identityFile && { identityFile: target.identityFile }),
    knownHostsFile: target.knownHostsFile, hostKeyAlias: target.hostKeyAlias,
  };
  const { lines, fingerprints } = await scanHostKey(ssh);
  console.log(`Host ${target.host}:${target.port} presents:`);
  for (const fingerprint of fingerprints) console.log(`  ${fingerprint}`);
  console.log('Compare this with a fingerprint obtained on the machine itself before accepting it.');
  if (!argv.includes('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('Refusing to write the key without --yes on a non-interactive terminal.');
      return 2;
    }
    process.stdout.write(`Accept it into ${target.knownHostsFile}? [y/N] `);
    const answer = await new Promise(resolve => process.stdin.once('data', data => resolve(String(data).trim().toLowerCase())));
    if (answer !== 'y' && answer !== 'yes') {
      console.error('Not accepted.');
      return 1;
    }
  }
  await acceptHostKey(ssh, lines);
  console.log(`Accepted into ${target.knownHostsFile}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error(error instanceof RemoteEnvError ? error.message : 'Remote environment command failed.');
    process.exit(1);
  });
}
