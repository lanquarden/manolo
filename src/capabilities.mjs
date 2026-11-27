import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TASK_CATALOG_LIMIT, TASK_PROFILE_LIMIT } from './work-blueprints.mjs';

// Everything this module returns is owner-visible and rendered verbatim, so it holds only names, descriptions, relative
// paths and byte counts: never file contents, environment values, credentials, or absolute paths.
const MAX_TOOLS = 128;
const MAX_SKILLS = 12;
const MAX_SKILL_DIRECTORIES = 256;
const MAX_SKILL_DEPTH = 2;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILL_DESCRIPTION = 1024;
const MAX_AGENT_FILES = 16;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_SUMMARY = 160;
const MAX_INSTRUCTIONS = 4000;
const MAX_BUILTIN_INSTRUCTIONS = 4000;
const MAX_WALK_UP = 16;
// A skill section is appended to a real prompt; keep it small enough that it never crowds out the turn.
export const MAX_SKILL_SECTION_CHARS = 2500;
const SKILL_INTRO = 'Repository skills found in the pod workspace. When a task matches one, read its SKILL.md and follow it.';
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Same filter as blueprint text: control and bidi characters are never prompt or display material.
const unsafeText = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

const statOrNull = async path => {
  try { return await stat(path); } catch { return null; }
};

const realpathOrNull = async path => {
  try { return await realpath(path); } catch { return null; }
};

// A path is inside a root when it is the root itself or begins with `root/`.
const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Opens a regular file without following a final symlink, checks the opened descriptor (not the path) is a regular file
 * within the byte cap, and reads it. A repository can be written by the agent, so a `SKILL.md` symlink must not be able
 * to pull an out-of-tree file's text into a prompt or the owner's review panel.
 */
async function readRegularFileNoFollow(path, maxBytes, rootReal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    // The final component cannot be a symlink (O_NOFOLLOW), but an ancestor could have been swapped between the realpath
    // check and this open. Ask the kernel where the descriptor actually points and re-check containment.
    if (rootReal !== undefined) {
      const opened = await realpathOrNull(`/proc/self/fd/${handle.fd}`);
      if (opened === null) {
        // No /proc means no way to ask the kernel where the descriptor points. On a system that has it, an unreadable
        // entry is a failure, not a reason to trust the path we were handed.
        if (await realpathOrNull('/proc/self/fd') !== null) return undefined;
      } else if (!inside(opened, rootReal)) return undefined;
    }
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Trim text to a UTF-8 byte budget on a code-point boundary: a character budget over bytes can yield nothing at all for
// text that is not ASCII.
function clipBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    used += size;
    out += character;
  }
  return out;
}

// A repository root is a directory that has a `.git` entry, which may be a directory or (in a worktree) a file.
async function scanRoots(workspace) {
  const roots = [workspace];
  let current = workspace;
  for (let depth = 1; depth < MAX_WALK_UP; depth += 1) {
    if (await statOrNull(join(current, '.git')) !== null) return roots;
    const parent = dirname(current);
    // No repository root: only the workspace is in scope. Walking to `/` instead would inspect unrelated trees.
    if (parent === current) return [workspace];
    current = parent;
    roots.push(current);
  }
  return [workspace];
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

// Reads only the leading YAML block and only the two fields the Agent Skills convention routes on. Anything it does not
// understand is ignored rather than fatal: a malformed skill is skipped, not an error for every other skill.
function frontmatter(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return undefined;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (close < 0) return undefined;
  const fields = {};
  for (let i = 1; i < close; i += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!match) continue;
    const [, key, raw = ''] = match;
    let value = raw.trim();
    if (/^[>|][+-]?$/.test(value)) {
      // A folded or literal block: the description is the indented body, whichever indicator was used.
      const body = [];
      while (i + 1 < close && (lines[i + 1].trim() === '' || /^[ \t]/.test(lines[i + 1]))) {
        i += 1;
        if (lines[i].trim() !== '') body.push(lines[i].trim());
      }
      value = body.join(' ');
    } else value = unquote(value);
    if (key === 'name' || key === 'description') fields[key] = value;
  }
  return fields;
}

const oneLine = text => String(text ?? '').replace(unsafeText, '').replace(/\s+/g, ' ').trim();

function clip(text, limit) {
  const value = oneLine(text);
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

// Instructions are reviewed as the prompt they are, so their line breaks survive; only control characters are removed.
const MULTILINE_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu;
function clipLines(text, limit) {
  // A field cap, not a UI ellipsis: the panel shows exactly the prompt text up to the same 4,000-unit budget the
  // instructions already have.
  return String(text ?? '').replace(MULTILINE_UNSAFE, '').slice(0, limit);
}

// Tool descriptions are paragraphs; the inventory only needs the routing line.
function firstLine(text, limit) {
  const line = oneLine(String(text ?? '').split('\n').find(part => part.trim() !== '') ?? '');
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function parseSkill(text) {
  const fields = frontmatter(text);
  if (!fields) return undefined;
  const name = oneLine(fields.name);
  const description = oneLine(fields.description);
  if (!name || name.length > 64 || !SKILL_NAME.test(name)) return undefined;
  if (!description || description.length > MAX_SKILL_DESCRIPTION) return undefined;
  return { name, description };
}

// One cache entry per workspace. The stamp holds the mtime of every directory and SKILL.md the scan looked at, so a
// turn revalidates with a handful of stats instead of walking the tree, and an edit or an added skill invalidates it.
const skillCache = new Map();

async function cacheFresh(stamp) {
  for (const [path, mtime] of stamp) {
    if (((await statOrNull(path))?.mtimeMs ?? null) !== mtime) return false;
  }
  return true;
}

async function scanSkills(workspace) {
  const roots = await scanRoots(workspace);
  const skills = [];
  const seen = new Set();
  const stamp = [];
  let visited = 0;

  async function readDirectory(dir, role, depth, rootReal) {
    if (visited >= MAX_SKILL_DIRECTORIES || skills.length >= MAX_SKILLS) return;
    visited += 1;
    const info = await statOrNull(dir);
    stamp.push([dir, info?.mtimeMs ?? null]);
    if (!info?.isDirectory()) return;
    // A symlinked `.agents/skills` (or a symlinked ancestor of it) would point the whole scan out of the repository.
    const dirReal = await realpathOrNull(dir);
    if (dirReal === null || !inside(dirReal, rootReal)) return;
    const skillFile = join(dir, 'SKILL.md');
    const fileInfo = await statOrNull(skillFile);
    if (fileInfo?.isFile()) {
      stamp.push([skillFile, fileInfo.mtimeMs]);
      // A SKILL.md this large is not a routing header; skip it and do not treat its subdirectories as skills.
      if (fileInfo.size > MAX_SKILL_FILE_BYTES || skills.length >= MAX_SKILLS) return;
      let parsed;
      try { parsed = parseSkill(await readRegularFileNoFollow(skillFile, MAX_SKILL_FILE_BYTES, rootReal)); } catch { parsed = undefined; }
      if (parsed && !seen.has(parsed.name)) {
        seen.add(parsed.name);
        const path = relative(workspace, skillFile);
        if (path && !isAbsolute(path)) skills.push({ ...parsed, path, source: role });
      }
      return;
    }
    if (depth >= MAX_SKILL_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      // `withFileTypes` reports a symlink as such, so a link to another directory is never traversed.
      if (!entry.isDirectory()) continue;
      await readDirectory(join(dir, entry.name), role, depth + 1, rootReal);
    }
  }

  const repository = roots.at(-1);
  const workspaceReal = await realpathOrNull(workspace);
  for (const root of roots) {
    const rootReal = await realpathOrNull(root);
    // An ancestor reached through a symlink is not a real ancestor of the workspace; refuse it rather than guess.
    if (workspaceReal === null || rootReal === null || !inside(workspaceReal, rootReal)) continue;
    const role = root === workspace ? 'workspace' : root === repository ? 'repository' : 'ancestor';
    await readDirectory(join(root, '.agents', 'skills'), role, 0, rootReal);
  }
  return { skills, stamp };
}

export async function discoverSkills(workspaceDir) {
  const workspace = resolve(workspaceDir);
  const cached = skillCache.get(workspace);
  if (cached && await cacheFresh(cached.stamp)) return cached.skills;
  let scan;
  try { scan = await scanSkills(workspace); } catch { return []; }
  // Bound the cache: a process serves one workspace, but tests and embedded use may probe several.
  if (skillCache.size >= 8) skillCache.delete(skillCache.keys().next().value);
  skillCache.set(workspace, scan);
  return scan.skills;
}

// Every AGENTS.md from the workspace up to the repository root. Paths are relative to the workspace and only sizes are
// reported, so the owner can see which guidance files exist without the endpoint echoing their contents.
async function findAgentsFiles(workspace) {
  const files = [];
  for (const root of await scanRoots(workspace)) {
    if (files.length >= MAX_AGENT_FILES) break;
    const file = join(root, 'AGENTS.md');
    const info = await statOrNull(file);
    if (!info?.isFile()) continue;
    const path = relative(workspace, file);
    if (!path || isAbsolute(path)) continue;
    files.push({ path, bytes: info.size });
  }
  return files;
}

// A tool description can come from a remote MCP server, so it is redacted before it is clipped: clipping first would let
// a secret's prefix survive at the boundary.
function toolList(registry, safe = text => text) {
  let snapshot;
  try { snapshot = registry?.snapshot?.(); } catch { snapshot = undefined; }
  const entries = typeof snapshot?.tools === 'function' ? snapshot.tools() : [];
  return (Array.isArray(entries) ? entries : []).slice(0, MAX_TOOLS).flatMap(({ extension, tool }) => {
    const name = typeof tool?.name === 'string' ? clip(tool.name, 64) : '';
    if (!name) return [];
    return [{ name, description: firstLine(safe(String(tool.description ?? '')), MAX_SUMMARY), source: clip(extension?.name, 64) || 'worker' }];
  });
}

// The owner asked to review the prompt itself, not just its length. It is non-secret operator text plus the runtime's
// own rules, and it stays within the same 4,000-character budget the operator instructions already use.
function agentInfo(cfg, workSessionRules, safe) {
  // Redacted first and clipped second: a cap applied before redaction can leave a secret's prefix in the panel.
  const agent = {
    id: clip(cfg?.agentId, 128),
    instructions: clipLines(safe(cfg?.instructions), MAX_INSTRUCTIONS),
  };
  if (typeof workSessionRules === 'string' && workSessionRules !== '') {
    agent.workSessionRules = clipLines(safe(workSessionRules), MAX_BUILTIN_INSTRUCTIONS);
  }
  return agent;
}

const byteLength = value => Buffer.byteLength(JSON.stringify(value));

// Keep the whole response under the stated cap without dropping the one field the owner explicitly reviews. Informational
// lists lose their tail entries first, a selectable catalog row keeps its id and loses description text, and the agent
// text is clipped only after that.
function fitBudget(result) {
  // A tool or skill row is informational; a Blueprint or profile row is selectable by id. Only the informational lists
  // lose their tail, so the advertised catalog stays exactly what a Task can be created with at the configured limits.
  const shrinkable = ['tools', 'skills', 'agentsFiles'];
  let current = result;
  // Shrink the informational lists first: they are the bulk, and the two agent fields are what the owner came to read.
  while (byteLength(current) > MAX_JSON_BYTES) {
    let largest;
    let largestSize = -1;
    for (const name of shrinkable) {
      if (!current[name]?.length) continue;
      const size = byteLength(current[name]);
      if (size > largestSize) {
        largest = name;
        largestSize = size;
      }
    }
    if (largest === undefined) break;
    current = { ...current, [largest]: current[largest].slice(0, -1) };
  }
  // The catalog itself is never truncated: every configured Blueprint and profile stays visible by id, and only its
  // description shrinks to meet the budget. A hidden row would be an omission that is still selectable.
  if (byteLength(current) > MAX_JSON_BYTES) {
    const rows = (list, limit) => Array.isArray(list)
      ? list.map(row => ({ ...row, description: clipBytes(row.description ?? '', limit) })) : list;
    const withDescriptions = limit => ({
      ...current, blueprints: rows(current.blueprints, limit), profiles: rows(current.profiles, limit),
    });
    let best = withDescriptions(0);
    if (byteLength(best) <= MAX_JSON_BYTES) {
      let low = 0;
      let high = MAX_SUMMARY;
      while (low <= high) {
        const limit = Math.floor((low + high) / 2);
        const candidate = withDescriptions(limit);
        if (byteLength(candidate) <= MAX_JSON_BYTES) {
          best = candidate;
          low = limit + 1;
        } else {
          high = limit - 1;
        }
      }
    }
    current = best;
  }
  // The work-session rules are a runtime constant; drop them before touching the operator's instructions.
  if (byteLength(current) > MAX_JSON_BYTES && current.agent.workSessionRules !== undefined) {
    const { workSessionRules, ...agent } = current.agent;
    current = { ...current, agent };
  }
  // A pathological prompt can still exceed the cap (multi-byte or escaped characters). Clip on byte boundaries and
  // re-check until it fits, so the promise that the response is bounded actually holds.
  for (let attempt = 0; attempt < 4 && byteLength(current) > MAX_JSON_BYTES; attempt += 1) {
    const instructions = current.agent.instructions;
    const budget = Math.max(0, Buffer.byteLength(instructions) - (byteLength(current) - MAX_JSON_BYTES));
    const clipped = clipBytes(instructions, budget);
    current = { ...current, agent: { ...current.agent, instructions: clipped } };
    if (clipped === '') break;
  }
  return current;
}

export async function readCapabilities({ workspaceDir, registry, cfg, blueprints, profiles, workSessionRules, redact = text => text }) {
  const workspace = resolve(workspaceDir);
  const skills = await discoverSkills(workspace);
  const safe = text => redact(String(text ?? ''));
  const result = {
    // Instructions are operator text, but a blueprint or an environment reference can still carry a token.
    agent: agentInfo(cfg, workSessionRules, safe),
    tools: toolList(registry, safe),
    blueprints: [...(blueprints?.values?.() ?? [])].slice(0, TASK_CATALOG_LIMIT).flatMap(blueprint => {
      const id = clip(blueprint?.id, 64);
      if (!id) return [];
      return [{ id, description: clip(safe(blueprint?.description), MAX_SUMMARY),
        ...(blueprint?.profile && { profile: clip(blueprint.profile.id, 64) }) }];
    }),
    profiles: [...(profiles?.values?.() ?? [])].slice(0, TASK_PROFILE_LIMIT).flatMap(profile => {
      const id = clip(profile?.id, 64);
      if (!id) return [];
      return [{ id, description: clip(safe(profile?.description), MAX_SUMMARY),
        model: clip(`${profile.model.provider}/${profile.model.modelId}`, 128),
        ...(profile.thinkingLevel && { thinkingLevel: profile.thinkingLevel }) }];
    }),
    agentsFiles: await findAgentsFiles(workspace),
    // The panel shows a routing summary; the full description stays in the prompt section, where it belongs. Skill text
    // comes from a repository file, so it is redacted like any other untrusted prose before the owner sees it.
    skills: skills.map(skill => ({
      name: skill.name, description: clip(safe(skill.description), MAX_SUMMARY), path: skill.path, source: skill.source,
    })),
  };
  return fitBudget(result);
}

// Prompt text for the admitted turn, or '' when the repository has no skills so the prompt stays byte-identical.
// Every skill is listed: descriptions shrink evenly instead of later skills silently disappearing from the section.
export function skillSection(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const listed = skills.slice(0, MAX_SKILLS);
  const overhead = listed.reduce((sum, skill) => sum + 4 + skill.name.length + 2 + skill.path.length + 3, 0);
  const share = Math.max(24, Math.floor((MAX_SKILL_SECTION_CHARS - SKILL_INTRO.length - overhead) / listed.length));
  let text = SKILL_INTRO;
  for (const skill of listed) {
    const description = skill.description.length > share
      ? `${skill.description.slice(0, share - 1).trimEnd()}…`
      : skill.description;
    const line = `\n- ${skill.name}: ${description} (${skill.path})`;
    if (text.length + line.length > MAX_SKILL_SECTION_CHARS) break;
    text += line;
  }
  if (text === SKILL_INTRO) return '';
  return text.length > MAX_SKILL_SECTION_CHARS
    ? `${text.slice(0, MAX_SKILL_SECTION_CHARS - 1).trimEnd()}…`
    : text;
}
