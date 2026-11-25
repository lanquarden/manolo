import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverSkills, MAX_SKILL_SECTION_CHARS, readCapabilities, skillSection } from '../src/capabilities.mjs';

const cwd = new URL('../', import.meta.url);
const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));

async function temp(t, prefix = 'manolo-capabilities-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function skillFile(name, description) {
  const frontmatter = description === undefined ? `name: ${name}` : `name: ${name}\ndescription: ${description}`;
  return `---\n${frontmatter}\n---\n\n# ${name}\n`;
}

async function writeSkill(directory, name, description) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), skillFile(name, description));
}

const fakeRegistry = (tools, extension = 'fixture-tools') => ({
  snapshot: () => ({ tools: () => tools.map(tool => ({ extension: { name: extension }, tool })) }),
});

test('repository skills are discovered from .agents/skills up to the repository root', async t => {
  const base = await temp(t);
  const root = join(base, 'repo');
  await mkdir(join(root, '.git'), { recursive: true });
  const skills = join(root, '.agents', 'skills');
  await writeSkill(join(skills, 'alpha'), 'alpha', 'Summarise release notes.');
  await writeSkill(join(skills, 'group', 'beta'), 'beta', 'Review a patch before it ships.');
  await writeSkill(join(skills, 'silent'), 'silent'); // Skipped: no description.
  await writeSkill(join(skills, 'Bad_Name'), 'Bad_Name', 'Invalid name.'); // Skipped: not a safe name.
  await writeSkill(join(skills, 'huge'), 'huge', 'x'.repeat(1025)); // Skipped: over the 1024-character limit.
  await writeSkill(join(skills, 'deep', 'one', 'two', 'gamma'), 'gamma', 'Too deep to be discovered.');
  await writeSkill(join(base, '.agents', 'skills', 'outside'), 'outside', 'Outside the repository root.');

  const found = await discoverSkills(root);
  assert.deepEqual(found.map(skill => skill.name).sort(), ['alpha', 'beta']);
  assert.deepEqual(found.find(skill => skill.name === 'alpha'), {
    name: 'alpha', description: 'Summarise release notes.', path: '.agents/skills/alpha/SKILL.md', source: 'workspace',
  });
  assert.deepEqual(found.find(skill => skill.name === 'beta'), {
    name: 'beta', description: 'Review a patch before it ships.', path: '.agents/skills/group/beta/SKILL.md', source: 'workspace',
  });
});

test('skills are scoped to the workspace chain that stops at the repository root', async t => {
  const base = await temp(t);
  const root = join(base, 'repo');
  const workspace = join(root, 'work');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeSkill(join(workspace, '.agents', 'skills', 'local'), 'local', 'Workspace skill.');
  await writeSkill(join(root, '.agents', 'skills', 'shared'), 'shared', 'Repository skill.');
  await writeSkill(join(base, '.agents', 'skills', 'outside'), 'outside', 'Not reachable.');

  assert.deepEqual((await discoverSkills(workspace)).map(({ name, path, source }) => ({ name, path, source })), [
    { name: 'local', path: '.agents/skills/local/SKILL.md', source: 'workspace' },
    { name: 'shared', path: '../.agents/skills/shared/SKILL.md', source: 'repository' },
  ]);
  // With no repository root anywhere above it, only the workspace is scanned: a missing directory is not an error.
  assert.deepEqual(await discoverSkills(join(base, 'unowned')), []);
  assert.deepEqual(await discoverSkills(join(base, 'missing')), []);
});

test('at most twelve skills are listed', async t => {
  const root = await temp(t);
  await mkdir(join(root, '.git'), { recursive: true });
  for (let index = 0; index < 14; index += 1) {
    const name = `skill-${String(index).padStart(2, '0')}`;
    await writeSkill(join(root, '.agents', 'skills', name), name, `Skill ${index}.`);
  }
  const found = await discoverSkills(root);
  assert.equal(found.length, 12);
  assert.deepEqual(found.map(skill => skill.name).sort(), Array.from({ length: 12 }, (_, index) => `skill-${String(index).padStart(2, '0')}`));
});

test('the skill scan is cached per directory and invalidated by an mtime change', async t => {
  const root = await temp(t);
  await mkdir(join(root, '.git'), { recursive: true });
  await writeSkill(join(root, '.agents', 'skills', 'alpha'), 'alpha', 'First.');
  const first = await discoverSkills(root);
  assert.strictEqual(await discoverSkills(root), first, 'a second admission reads from the cache');

  await writeSkill(join(root, '.agents', 'skills', 'beta'), 'beta', 'Second.');
  const later = new Date(Date.now() + 5000);
  await utimes(join(root, '.agents', 'skills'), later, later);
  const second = await discoverSkills(root);
  assert.notStrictEqual(second, first, 'a changed directory mtime forces a rescan');
  assert.deepEqual(second.map(skill => skill.name).sort(), ['alpha', 'beta']);

  // Editing an existing SKILL.md also invalidates the cache, so a description change reaches the next turn.
  await writeSkill(join(root, '.agents', 'skills', 'alpha'), 'alpha', 'Changed.');
  await utimes(join(root, '.agents', 'skills', 'alpha', 'SKILL.md'), later, later);
  assert.deepEqual((await discoverSkills(root)).map(skill => skill.description).sort(), ['Changed.', 'Second.']);
});

test('AGENTS.md files are reported by relative path and size only', async t => {
  const base = await temp(t);
  const root = join(base, 'repo');
  const workspace = join(root, 'work');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const local = '# Local guidance\nNever reveal the secret marker.';
  const ancestor = '# Repository guidance\nAnother private marker.';
  await writeFile(join(workspace, 'AGENTS.md'), local);
  await writeFile(join(root, 'AGENTS.md'), ancestor);

  const result = await readCapabilities({
    workspaceDir: workspace, registry: fakeRegistry([]), cfg: { agentId: 'primary', instructions: 'Base prompt' }, blueprints: new Map(),
  });
  assert.deepEqual(result.agentsFiles, [
    { path: 'AGENTS.md', bytes: Buffer.byteLength(local) },
    { path: '../AGENTS.md', bytes: Buffer.byteLength(ancestor) },
  ]);
  for (const file of result.agentsFiles) assert.deepEqual(Object.keys(file).sort(), ['bytes', 'path']);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /secret marker|private marker/);
  assert.deepEqual(result.skills, []);
  assert.ok(Buffer.byteLength(json) <= 8192);
});

test('capabilities carry the owner-visible prompt and tool sources inside the byte budget', async t => {
  const root = await temp(t);
  await mkdir(join(root, '.git'), { recursive: true });
  const names = Array.from({ length: 140 }, (_, index) => `tool-${String(index).padStart(3, '0')}`);
  const tools = names.map(name => ({ name, description: `First line of ${name}.\nSecond line must be dropped.` }));
  const result = await readCapabilities({
    workspaceDir: root,
    registry: fakeRegistry(tools),
    blueprints: new Map([['review', { id: 'review', description: 'Review short notes' }]]),
    cfg: { agentId: 'primary', instructions: 'x'.repeat(5000) },
    workSessionRules: 'Delegate carefully.',
  });
  assert.deepEqual(result.agent, { id: 'primary', instructions: 'x'.repeat(4000), workSessionRules: 'Delegate carefully.' });
  assert.deepEqual(result.blueprints, [{ id: 'review', description: 'Review short notes' }]);
  assert.deepEqual(result.tools[0], { name: 'tool-000', description: 'First line of tool-000.', source: 'fixture-tools' });
  assert.ok(result.tools.length > 0 && result.tools.length <= 128, JSON.stringify(result.tools.length));
  assert.deepEqual(result.tools.map(tool => tool.name), names.slice(0, result.tools.length), 'the list keeps discovery order');
  for (const tool of result.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'name', 'source']);
    assert.ok(tool.description.length <= 160);
    assert.doesNotMatch(tool.description, /\n/);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
});

test('the skills prompt section is bounded and lists every skill', () => {
  assert.equal(skillSection([]), '');
  assert.equal(skillSection(undefined), '');
  assert.equal(skillSection([{ name: 'alpha', description: 'Short.', path: '.agents/skills/alpha/SKILL.md', source: 'workspace' }]),
    'Repository skills found in the pod workspace. When a task matches one, read its SKILL.md and follow it.\n- alpha: Short. (.agents/skills/alpha/SKILL.md)');

  const skills = Array.from({ length: 12 }, (_, index) => ({
    name: `skill-${index}`, description: 'd'.repeat(1024), path: `.agents/skills/skill-${index}/SKILL.md`, source: 'workspace',
  }));
  const section = skillSection(skills);
  assert.ok(section.length <= MAX_SKILL_SECTION_CHARS, `${section.length} characters`);
  assert.match(section, /^Repository skills found in the pod workspace\. When a task matches one, read its SKILL\.md and follow it\./);
  for (const skill of skills) assert.ok(section.includes(`- ${skill.name}: `), skill.name);
});

// A minimal runnable relay and worker pair: enough to prove the owner route forwards and a stopped worker is a 503.
function startProcess(t, command, args, env) {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
  const exited = once(child, 'close');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };
  t.after(stop);
  return {
    stop,
    async listen(pattern) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        assert.equal(child.exitCode, null, log);
        const match = pattern.exec(log);
        if (match) return Number(match[1]);
        await sleep(25);
      }
      assert.fail(`Timed out waiting for ${pattern}: ${log}`);
    },
  };
}

test('the relay forwards capabilities for the owner and reports a stopped worker as 503', { timeout: 60_000 }, async t => {
  const root = await temp(t, 'manolo-capabilities-relay-');
  const token = randomBytes(24).toString('hex');
  const password = randomBytes(24).toString('hex');
  const worker = startProcess(t, process.execPath, [workerPath], {
    MANOLO_DATA_DIR: join(root, 'data'), MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'primary', MANOLO_AGENT_TOKEN: token, PORT: '0',
  });
  const workerPort = await worker.listen(/Manolo worker listening on (\d+)/);
  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify({
    agents: { primary: { url: `http://127.0.0.1:${workerPort}`, tokenEnv: 'PRIMARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' } },
    routes: [], inbox: [],
  }));
  const relay = startProcess(t, process.execPath, ['src/relay.mjs'], {
    MANOLO_DATA_DIR: join(root, 'relay-data'), MANOLO_RELAY_CONFIG: configPath,
    PORT: '0', MANOLO_INTERNAL_PORT: '0', PRIMARY_TOKEN: token, OWNER_PASSWORD: password,
  });
  const listeningPort = await relay.listen(/web listening on [^\s:]+:(\d+)/);
  const url = `http://127.0.0.1:${listeningPort}`;
  const basic = { authorization: `Basic ${Buffer.from(`owner:${password}`).toString('base64')}` };

  assert.equal((await fetch(`${url}/api/capabilities`, { signal: AbortSignal.timeout(5000) })).status, 401);
  const response = await fetch(`${url}/api/capabilities`, { headers: basic, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agent.id, 'primary');
  assert.ok(Array.isArray(body.tools) && body.tools.some(tool => tool.name === 'read' && tool.source === 'coding-tools'));
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 8192);
  // The route is read-only, like the capability view itself.
  const post = await fetch(`${url}/api/capabilities`, {
    method: 'POST', headers: { ...basic, 'x-manolo-request': '1' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(post.status, 404);

  await worker.stop();
  const down = await fetch(`${url}/api/capabilities`, { headers: basic, signal: AbortSignal.timeout(10_000) });
  assert.equal(down.status, 503);
});

test('a symlinked skill file or directory cannot pull text from outside the repository', async t => {
  const outside = await temp(t, 'manolo-capabilities-outside-');
  await writeSkill(join(outside, 'leak'), 'leaked', 'Instructions from outside the repository');
  const repo = await temp(t);
  await mkdir(join(repo, '.git'), { recursive: true });
  const skills = join(repo, '.agents', 'skills');
  await mkdir(skills, { recursive: true });
  await writeSkill(join(skills, 'real'), 'real', 'A real skill');
  // A SKILL.md that is a symlink out of the tree, and a directory symlink that would make the walk leave it.
  await mkdir(join(skills, 'linked'), { recursive: true });
  await symlink(join(outside, 'leak', 'SKILL.md'), join(skills, 'linked', 'SKILL.md'));
  await symlink(join(outside, 'leak'), join(skills, 'linked-dir'));

  const found = await discoverSkills(repo);
  assert.deepEqual(found.map(skill => skill.name), ['real']);
});

test('non-ASCII instructions keep their budget instead of being emptied', async () => {
  const result = await readCapabilities({
    workspaceDir: await mkdtemp(join(tmpdir(), 'manolo-capabilities-cjk-')),
    registry: undefined,
    cfg: { agentId: 'primary', instructions: '家'.repeat(4000) },
    blueprints: new Map(),
    redact: text => text,
  });
  assert.ok(result.agent.instructions.length > 0, 'CJK instructions must not clip to nothing');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024);
});

test('capabilities redact known secrets from instructions, tools and skills', async t => {
  const repo = await temp(t);
  const secret = 'super-secret-value-0123456789';
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeSkill(join(repo, '.agents', 'skills', 'notes'), 'notes', `Uses ${secret} on purpose`);
  const registry = {
    snapshot: () => ({
      tools: () => [{ extension: { name: 'coding-tools' }, tool: { name: 'bash', description: `Runs with ${secret}` } }],
    }),
  };
  const result = await readCapabilities({
    workspaceDir: repo, registry,
    cfg: { agentId: 'primary', instructions: `Operator text with ${secret}` },
    blueprints: new Map([['review', { id: 'review', description: `Blueprint that mentions ${secret}` }]]),
    redact: text => text.split(secret).join('[redacted]'),
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[redacted\]/);
});

test('a large MCP configuration survives the relay round trip', { timeout: 60_000 }, async t => {
  const root = await temp(t, 'manolo-mcp-relay-');
  const token = randomBytes(24).toString('hex');
  const password = randomBytes(24).toString('hex');
  const worker = startProcess(t, process.execPath, [workerPath], {
    MANOLO_DATA_DIR: join(root, 'data'), MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'primary', MANOLO_AGENT_TOKEN: token, PORT: '0',
  });
  const workerPort = await worker.listen(/Manolo worker listening on (\d+)/);
  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify({
    agents: { primary: { url: `http://127.0.0.1:${workerPort}`, tokenEnv: 'PRIMARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' } },
    routes: [], inbox: [],
  }));
  const relay = startProcess(t, process.execPath, ['src/relay.mjs'], {
    MANOLO_DATA_DIR: join(root, 'relay-data'), MANOLO_RELAY_CONFIG: configPath,
    PORT: '0', MANOLO_INTERNAL_PORT: '0', PRIMARY_TOKEN: token, OWNER_PASSWORD: password,
  });
  const url = `http://127.0.0.1:${await relay.listen(/web listening on [^\s:]+:(\d+)/)}`;
  const basic = { authorization: `Basic ${Buffer.from(`owner:${password}`).toString('base64')}` };
  // The worker bounds the config text at 128 KiB. A valid file of quoted strings JSON-escapes to well over that on the
  // wire, which is why the relay's budget for this route is separate from the text limit.
  const servers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`s${index}`, {
    command: '/bin/true',
    // A credential embedded as JSON escapes quotes and newlines, so a valid file is much larger on the wire.
    env: Object.fromEntries(Array.from({ length: 3 }, (_, slot) => [`V${slot}`, '{"key":"value"}\n'.repeat(240)])),
  }]));
  const text = JSON.stringify({ mcpServers: servers });
  const bytes = Buffer.byteLength(text);
  assert.ok(bytes > 60_000 && bytes < 128 * 1024, `${bytes} bytes`);
  // ~1.43x here: the wire JSON escapes every quote and newline of the embedded credential.
  assert.ok(Buffer.byteLength(JSON.stringify({ text })) > 1.3 * bytes);
  const written = await fetch(`${url}/api/mcp/config`, {
    method: 'PUT', headers: { ...basic, 'content-type': 'application/json', 'x-manolo-request': '1' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(written.status, 200, await written.text());
  const read = await fetch(`${url}/api/mcp`, { headers: basic, signal: AbortSignal.timeout(15_000) });
  assert.equal(read.status, 200);
  const state = await read.json();
  assert.equal(state.config, text);
  // The worker's own 128 KiB limit still applies to the text itself.
  const tooLarge = await fetch(`${url}/api/mcp/config`, {
    method: 'PUT', headers: { ...basic, 'content-type': 'application/json', 'x-manolo-request': '1' },
    // Trailing JSON whitespace keeps the document valid while pushing the text past the worker's 128 KiB limit.
    body: JSON.stringify({ text: `${text}${' '.repeat(40_000)}` }), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(tooLarge.status, 400);
  await tooLarge.body?.cancel();
});

test('instructions keep their line breaks and the whole response stays bounded', async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'manolo-capabilities-lines-'));
  const multiline = 'First line\nSecond line\n\n- a bullet';
  const plain = await readCapabilities({
    workspaceDir, registry: undefined, cfg: { agentId: 'primary', instructions: multiline }, blueprints: new Map(),
  });
  assert.equal(plain.agent.instructions, multiline);

  // CJK work-session rules alone can exceed the byte cap; the response must still fit, dropping them before the
  // operator's instructions.
  const huge = await readCapabilities({
    workspaceDir, registry: undefined, cfg: { agentId: 'primary', instructions: 'instr' }, blueprints: new Map(),
    workSessionRules: '規'.repeat(4000),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= 8 * 1024);
  assert.equal(huge.agent.instructions, 'instr');
  assert.equal(huge.agent.workSessionRules, undefined);
});
