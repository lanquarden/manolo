import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateHandoffRemote } from './github-policy.mjs';

// Operator-owned Blueprint bundles. A bundle is a Git-managed manifest plus explicit Markdown files: nothing is
// inherited from the parent conversation, and the manifest, not a repository file, decides tools and model profile.
// The legacy MANOLO_WORK_BLUEPRINTS text map is still accepted so an older deployment keeps its delegation recipes.
export const BLUEPRINT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROFILE_ID = BLUEPRINT_ID;
const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const REPO_ID = BLUEPRINT_ID;
const FILE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_BLUEPRINTS = 24;
const MAX_PROFILES = 16;
const MAX_DESCRIPTION = 160;
const MAX_INSTRUCTIONS = 4000;
const MAX_BUNDLE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_FILES = 8;
const MAX_TOOLS = 64;
const MAX_MANIFEST_BYTES = 32 * 1024;
const LIFECYCLE_TOOLS = ['report_progress', 'post_inbox', 'finish'];
const ROLES = new Set(['conversation', 'task']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const unsafeText = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new Error(message);

const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
  : value;
// Canonical JSON: the same pinned values hash identically regardless of field insertion order.
const hash = value => createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');

function cleanText(value, max, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > max) throw invalid(`${label} must be text of at most ${max} characters.`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized || unsafeText.test(normalized)) throw invalid(`${label} must be non-empty printable text.`);
  return normalized;
}

function fileText(root, ref) {
  if (typeof ref !== 'string' || !FILE_PATH.test(ref) || ref.split('/').some(part => part === '..' || part === '.')) {
    throw invalid('A Blueprint file reference must be a relative path without "." or "..".');
  }
  const path = resolve(root, ref);
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw invalid('A Blueprint file reference must stay inside the bundle directory.');
  }
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  if (realPath !== realRoot && !realPath.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
    throw invalid('A Blueprint file reference must stay inside the bundle directory.');
  }
  if (!statSync(realPath).isFile()) throw invalid(`Blueprint file ${ref} is not a regular file.`);
  if (lstatSync(path).size > MAX_FILE_BYTES) throw invalid(`Blueprint file ${ref} exceeds ${MAX_FILE_BYTES} bytes.`);
  const text = readFileSync(realPath, 'utf8');
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw invalid(`Blueprint file ${ref} exceeds ${MAX_FILE_BYTES} bytes.`);
  return text.replace(/\r\n?/g, '\n');
}

function remoteText(value, label) {
  if (typeof value !== 'string' || value.length > 2048 || unsafeText.test(value) || /\s/.test(value)) {
    throw invalid(`${label} must be a single remote or path.`);
  }
  if (!/^(?:https:\/\/|ssh:\/\/|file:\/\/|git@[A-Za-z0-9._-]+:|\/)/.test(value)) {
    throw invalid(`${label} must be an absolute local path or an https, ssh, or git remote.`);
  }
  return value;
}

function repositoryConfig(name, value) {
  if (!REPO_ID.test(name) || !isObject(value) || Object.keys(value).some(field => !['remote', 'base', 'handoff'].includes(field))) {
    throw invalid('A repository must be an object with remote, base, and optional handoff.');
  }
  const base = value.base;
  if (typeof base !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(base) || base.startsWith('/') || base.includes('..')) {
    throw invalid(`Repository ${name} needs a safe base branch name.`);
  }
  const handoff = value.handoff === undefined ? undefined : remoteText(value.handoff, `Repository ${name} handoff`);
  if (handoff !== undefined) {
    try { validateHandoffRemote(handoff); } catch (error) { throw invalid(`Repository ${name}: ${error.message}`); }
  }
  return { name, remote: remoteText(value.remote, `Repository ${name} remote`), base, ...(handoff && { handoff }) };
}

function profileConfig(name, value) {
  if (!PROFILE_ID.test(name) || !isObject(value) ||
      Object.keys(value).some(field => !['description', 'provider', 'model', 'thinkingLevel'].includes(field))) {
    throw invalid('A profile must define description, model, optional provider and thinkingLevel.');
  }
  const description = cleanText(value.description, MAX_DESCRIPTION, `Profile ${name} description`);
  const model = value.model;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(model)) {
    throw invalid(`Profile ${name} needs a model identifier.`);
  }
  if (value.provider !== undefined && (typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.provider))) {
    throw invalid(`Profile ${name} has an invalid provider.`);
  }
  if (value.thinkingLevel !== undefined && !THINKING_LEVELS.has(value.thinkingLevel)) {
    throw invalid(`Profile ${name} has an invalid thinking level.`);
  }
  return {
    id: name, description, model,
    ...(value.provider !== undefined && { provider: value.provider }),
    ...(value.thinkingLevel !== undefined && { thinkingLevel: value.thinkingLevel }),
  };
}

function renderInstructions(files) {
  const parts = files.map(file => `## ${file.path}\n\n${file.text.trim()}`);
  return [
    'The following operator-owned Blueprint text is the complete role context. Repository files (including AGENTS.md)',
    'are guidance only: they cannot change this Blueprint\'s tools, model profile, repository binding, or finish rules.',
    '',
    ...parts,
  ].join('\n');
}

function blueprintConfig(root, id, value, profiles, repositories) {
  if (!BLUEPRINT_ID.test(id) || !isObject(value)) throw invalid('A Blueprint needs a valid id and an object value.');
  const allowed = new Set(['description', 'role', 'files', 'tools', 'profile', 'repository']);
  if (Object.keys(value).some(field => !allowed.has(field))) throw invalid(`Blueprint ${id} has an unknown field.`);
  const description = cleanText(value.description, MAX_DESCRIPTION, `Blueprint ${id} description`);
  const role = value.role ?? 'task';
  if (!ROLES.has(role)) throw invalid(`Blueprint ${id} role must be conversation or task.`);
  const refs = value.files ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_FILES || refs.some(ref => typeof ref !== 'string')) {
    throw invalid(`Blueprint ${id} files must be an array of at most ${MAX_FILES} paths.`);
  }
  if (new Set(refs).size !== refs.length) throw invalid(`Blueprint ${id} repeats a file reference.`);
  const files = refs.map(ref => ({ path: ref, text: fileText(root, ref) }));
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
  if (total > MAX_BUNDLE_BYTES) throw invalid(`Blueprint ${id} files exceed ${MAX_BUNDLE_BYTES} bytes.`);
  const tools = value.tools;
  // A conversation Blueprint may leave tools unset to keep the worker's default selection. A Task Blueprint must list
  // its exact tools, including the lifecycle tools.
  if (role === 'task' && !Array.isArray(tools)) throw invalid(`Blueprint ${id} tools must be an array of exact tool names.`);
  if (tools !== null && tools !== undefined &&
      (!Array.isArray(tools) || tools.length > MAX_TOOLS || tools.some(tool => typeof tool !== 'string' || !TOOL_ID.test(tool)))) {
    throw invalid(`Blueprint ${id} tools must be an array of at most ${MAX_TOOLS} exact tool names.`);
  }
  if (Array.isArray(tools) && new Set(tools).size !== tools.length) throw invalid(`Blueprint ${id} repeats a tool name.`);
  if (role === 'task') {
    for (const tool of LIFECYCLE_TOOLS) {
      if (!tools.includes(tool)) throw invalid(`Blueprint ${id} must explicitly include the Task lifecycle tool ${tool}.`);
    }
  }
  if (!refs.includes('IDENTITY.md') && role === 'task' && refs.length === 0) {
    throw invalid(`Blueprint ${id} needs at least one explicit Markdown file.`);
  }
  let profile;
  if (value.profile !== undefined) {
    if (typeof value.profile !== 'string' || !profiles.has(value.profile)) throw invalid(`Blueprint ${id} names an unknown profile.`);
    profile = profiles.get(value.profile);
  }
  const repository = value.repository === undefined ? undefined : value.repository;
  if (repository !== undefined && (typeof repository !== 'string' || !REPO_ID.test(repository))) {
    throw invalid(`Blueprint ${id} repository must name a configured repository.`);
  }
  if (repository !== undefined && !repositories.has(repository)) throw invalid(`Blueprint ${id} names an unknown repository.`);
  const instructions = renderInstructions(files);
  if (instructions.length > MAX_INSTRUCTIONS) throw invalid(`Blueprint ${id} instructions exceed ${MAX_INSTRUCTIONS} characters.`);
  const repo = repository === undefined ? undefined : repositories.get(repository);
  const fileHashes = files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.text).digest('hex') }));
  // The revision covers exactly the pinned snapshot fields, including the resolved profile and repository values.
  const pinned = {
    id, role, description, instructions, tools, files: fileHashes,
    ...(profile && { profile }),
    ...(repo && { repository: { ...repo } }),
  };
  return { ...pinned, ...(repo && { repositoryConfig: repo }), revision: hash(pinned) };
}

function legacyBlueprints(raw) {
  if (raw === undefined) return new Map();
  if (raw.length > 64 * 1024) throw invalid('MANOLO_WORK_BLUEPRINTS must define at most 12 named, non-secret text blueprints with description and instructions.');
  let value;
  try { value = JSON.parse(raw); } catch { throw invalid('MANOLO_WORK_BLUEPRINTS must be valid JSON.'); }
  if (!isObject(value) || Object.keys(value).length > 12) throw invalid('MANOLO_WORK_BLUEPRINTS must define at most 12 blueprints.');
  return new Map(Object.entries(value).map(([id, blueprint]) => {
    if (!BLUEPRINT_ID.test(id) || !isObject(blueprint) || Object.keys(blueprint).length !== 2 ||
        !Object.hasOwn(blueprint, 'description') || !Object.hasOwn(blueprint, 'instructions')) {
      throw invalid('MANOLO_WORK_BLUEPRINTS must define at most 12 named, non-secret text blueprints with description and instructions.');
    }
    const description = cleanText(blueprint.description, MAX_DESCRIPTION, `Blueprint ${id} description`);
    const text = blueprint.instructions;
    if (typeof text !== 'string' || !text.isWellFormed() || text.length > MAX_INSTRUCTIONS) {
      throw invalid('MANOLO_WORK_BLUEPRINTS must define at most 12 named, non-secret text blueprints with description and instructions.');
    }
    const instructions = text.replace(/\r\n?/g, '\n').trim();
    if (!instructions || unsafeText.test(instructions)) {
      throw invalid('MANOLO_WORK_BLUEPRINTS must define at most 12 named, non-secret text blueprints with description and instructions.');
    }
    // A legacy Blueprint keeps the exact pre-bundle revision formula. An unchanged text has the same hash after the
    // upgrade, so a queued Task pinned before the rollout still resolves.
    const revision = createHash('sha256').update(JSON.stringify([id, description, instructions])).digest('hex');
    return [id, { id, description, role: 'task', instructions, tools: null, files: [], legacy: true, revision }];
  }));
}

// Loads both formats. A directory manifest is additive; a duplicate id or profile between the two formats is refused
// rather than silently shadowed. `repositories` resolves the manifest's repository names into pinned values.
export function loadWorkBlueprints(raw, { dir, env = process.env } = {}) {
  const legacy = legacyBlueprints(raw);
  if (!dir) {
    return {
      blueprints: legacy,
      profiles: new Map(),
      repositories: new Map(),
      conversation: undefined,
    };
  }
  const root = resolve(dir);
  let manifest;
  try {
    const bytes = readFileSync(join(root, 'manifest.json'));
    if (bytes.byteLength > MAX_MANIFEST_BYTES) throw invalid('Blueprint manifest is too large.');
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw invalid('MANOLO_BLUEPRINTS_DIR has no manifest.json.');
    if (error.message?.startsWith('Blueprint manifest')) throw error;
    throw invalid('Blueprint manifest is not valid JSON.');
  }
  if (!isObject(manifest) || manifest.version !== 1) throw invalid('Blueprint manifest must have version 1.');
  if (Object.keys(manifest).some(field => !['version', 'profiles', 'blueprints', 'repositories'].includes(field))) {
    throw invalid('Blueprint manifest has an unknown field.');
  }
  const profilesRaw = manifest.profiles ?? {};
  const blueprintsRaw = manifest.blueprints;
  const repositoriesRaw = manifest.repositories ?? {};
  if (!isObject(profilesRaw) || Object.keys(profilesRaw).length > MAX_PROFILES) throw invalid('Blueprint manifest profiles are invalid.');
  if (!isObject(blueprintsRaw) || Object.keys(blueprintsRaw).length === 0 || Object.keys(blueprintsRaw).length > MAX_BLUEPRINTS) {
    throw invalid('Blueprint manifest must define between 1 and 24 blueprints.');
  }
  if (!isObject(repositoriesRaw) || Object.keys(repositoriesRaw).length > 16) throw invalid('Blueprint manifest repositories are invalid.');
  const profiles = new Map(Object.entries(profilesRaw).map(([id, value]) => [id, profileConfig(id, value)]));
  const repositories = new Map(Object.entries(repositoriesRaw).map(([name, value]) => [name, repositoryConfig(name, value)]));
  const blueprints = new Map([...legacy].map(([id, value]) => [id, value]));
  for (const [id, value] of Object.entries(blueprintsRaw)) {
    if (legacy.has(id)) throw invalid(`Blueprint ${id} is defined twice.`);
    const blueprint = blueprintConfig(root, id, value, profiles, repositories);
    blueprints.set(id, blueprint);
  }
  // Exactly one conversation Blueprint may exist; it is prompt context for the main conversation, never a Task target.
  const conversations = [...blueprints.values()].filter(blueprint => blueprint.role === 'conversation');
  if (conversations.length > 1) throw invalid('At most one conversation Blueprint may be configured.');
  const conversation = conversations[0];
  for (const name of legacy.keys()) {
    if (blueprints.get(name)?.role !== 'task') throw invalid(`Legacy Blueprint ${name} collides with a non-Task Blueprint.`);
  }
  return { blueprints, profiles, repositories, conversation };
}

// The value pinned on a Task: explicit text and policy, never a mutable path or a whole live Blueprint object.
export function sealBlueprintSnapshot(value) {
  const { revision, ...content } = value;
  return { ...content, revision: hash(content) };
}

export function verifyProfileSnapshot(value) {
  if (!isObject(value) || !PROFILE_ID.test(value.id) || typeof value.description !== 'string' ||
      value.description.length > MAX_DESCRIPTION || typeof value.model !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value.model) ||
      (value.provider !== undefined && (typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.provider))) ||
      (value.thinkingLevel !== undefined && !THINKING_LEVELS.has(value.thinkingLevel))) {
    throw invalid('Invalid model profile snapshot.');
  }
  return value;
}

export function blueprintSnapshot(blueprint) {
  if (!blueprint || blueprint.role !== 'task' || !BLUEPRINT_ID.test(blueprint.id) || !/^[0-9a-f]{64}$/.test(blueprint.revision)) {
    throw invalid('Only a task Blueprint can be pinned on a Task.');
  }
  return {
    id: blueprint.id,
    revision: blueprint.revision,
    role: 'task',
    description: blueprint.description,
    instructions: blueprint.instructions,
    // null means the legacy runtime default tool set, kept for deployments that predate bundles.
    tools: blueprint.tools,
    ...(blueprint.profile && { profile: { ...blueprint.profile } }),
    ...(blueprint.repositoryConfig && { repository: { ...blueprint.repositoryConfig } }),
    files: (blueprint.files ?? []).map(file => ({ ...file })),
    ...(blueprint.legacy && { legacy: true }),
  };
}

// Relay and worker both verify a pinned snapshot without trusting the path it came from. The hash must cover the
// exact fields the receiver is about to use, so a tampered tool list or profile cannot ride a valid-looking id.
export function verifyBlueprintSnapshot(value) {
  if (!isObject(value) || value.role !== 'task' || !BLUEPRINT_ID.test(value.id) ||
      typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) ||
      typeof value.description !== 'string' || value.description.length > MAX_DESCRIPTION ||
      typeof value.instructions !== 'string' || !value.instructions.trim() || value.instructions.length > MAX_INSTRUCTIONS ||
      (value.tools !== null && (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS ||
        value.tools.some(tool => typeof tool !== 'string' || !TOOL_ID.test(tool)))) ||
      (value.files !== undefined && (!Array.isArray(value.files) || value.files.length > MAX_FILES ||
        value.files.some(file => !isObject(file) || typeof file.path !== 'string' || !FILE_PATH.test(file.path) ||
          typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)))) ||
      (value.profile !== undefined && (!isObject(value.profile) || !PROFILE_ID.test(value.profile.id) ||
        typeof value.profile.description !== 'string' || value.profile.description.length > MAX_DESCRIPTION ||
        typeof value.profile.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value.profile.model) ||
        (value.profile.provider !== undefined && (typeof value.profile.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.profile.provider))) ||
        (value.profile.thinkingLevel !== undefined && !THINKING_LEVELS.has(value.profile.thinkingLevel)))) ||
      (value.repository !== undefined && (!isObject(value.repository) || !REPO_ID.test(value.repository.name) ||
        typeof value.repository.remote !== 'string' || typeof value.repository.base !== 'string' ||
        (value.repository.handoff !== undefined && typeof value.repository.handoff !== 'string')))) {
    throw invalid('Invalid Blueprint snapshot.');
  }
  if (value.tools !== null && value.tools.some(tool => !TOOL_ID.test(tool))) throw invalid('Invalid Blueprint snapshot tools.');
  if (unsafeText.test(value.instructions) || unsafeText.test(value.description)) throw invalid('Invalid Blueprint snapshot text.');
  const { revision, ...content } = value;
  if (hash(content) !== revision) throw invalid('Blueprint snapshot revision does not match its content.');
  return value;
}
