import { validateMcpServerConfig } from '@earendil-works/pi-mcp';

// MCP configuration lives with the agent's data, not in this repository: the owner or the agent edits
// `<data>/mcp.json`, and the worker applies changes without a restart. Helm can seed the file on first start.
// The entry shape is the shared `mcpServers` object, so a server block can be copied from another MCP client.
export const MCP_FILE = 'mcp.json';
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SERVERS = 8;
const MAX_TOOLS_PER_SERVER = 48;
const MAX_TOOLS = 96;
const EXPOSURES = new Set(['direct', 'deferred', 'codemode', 'hidden']);
const KNOWN_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'description', 'enabled', 'timeout', 'exposure', 'toolExposure', 'oauth']);
const OAUTH_FIELDS = new Set(['clientId', 'clientSecret', 'scope', 'authServerMetadataUrl']);

export class McpConfigError extends Error {}

// `${NAME}` in an env or header value is filled from the worker's own environment, which the chart points at a
// Secret. A reference to a name that is not set is an error rather than an empty credential.
export function expandValue(value, env, referenced) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g, (whole, name) => {
    const resolved = env[name];
    if (typeof resolved !== 'string' || resolved === '') throw new McpConfigError(`mcp.json references an unset environment variable: ${name}`);
    referenced?.add(name);
    return resolved;
  });
}

function expandRecord(record, env, label, referenced) {
  if (record === undefined) return undefined;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new McpConfigError(`${label} must be an object`);
  const expanded = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length > 8192) throw new McpConfigError(`${label}.${key} must be a short string`);
    expanded[key] = expandValue(value, env, referenced);
  }
  return expanded;
}

function noReferences(value, label) {
  if (typeof value !== 'string') return value;
  if (value.includes('${')) throw new McpConfigError(`${label} cannot reference environment variables; only env and headers may`);
  return value;
}

// Exact tool names win over `prefix*` patterns; the first matching pattern decides. Same shape as pi's toolExposure.
export function exposureFor(server, tool) {
  const base = server.exposure ?? 'direct';
  for (const [pattern, exposure] of Object.entries(server.toolExposure ?? {})) {
    if (pattern === tool) return exposure;
  }
  for (const [pattern, exposure] of Object.entries(server.toolExposure ?? {})) {
    if (pattern.endsWith('*') && tool.startsWith(pattern.slice(0, -1))) return exposure;
  }
  return base;
}

/**
 * Parse the `{ "mcpServers": { ... } }` document. Operator-authored configuration is a trust boundary, so an unknown
 * field, a bad name or an unreachable reference fails loudly here instead of being silently ignored.
 */
export function parseMcpConfig(text, env = process.env) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new McpConfigError('mcp.json is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpConfigError('mcp.json must be an object');
  const unknown = Object.keys(raw).filter(key => key !== 'mcpServers');
  if (unknown.length > 0) throw new McpConfigError(`mcp.json has unknown top-level fields: ${unknown.join(', ')}`);
  const servers = raw.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new McpConfigError('mcp.json must have an "mcpServers" object');
  if (Object.keys(servers).length > MAX_SERVERS) throw new McpConfigError(`mcp.json may configure at most ${MAX_SERVERS} servers`);

  const parsed = new Map();
  const secrets = new Set();
  const referencedEnv = new Set();
  for (const [name, entry] of Object.entries(servers)) {
    if (!NAME.test(name)) throw new McpConfigError(`mcp.json has an invalid server name: ${String(name).slice(0, 40)}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new McpConfigError(`mcp.json server ${name} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!KNOWN_FIELDS.has(key)) throw new McpConfigError(`mcp.json server ${name} has an unknown field: ${key}`);
    }
    // The redirect URI, client registration and callback server belong to Manolo: the worker signs in through the
    // relay's callback route. Only a pre-registered client and its scope are the operator's business here.
    if (entry.oauth !== undefined) {
      if (!entry.oauth || typeof entry.oauth !== 'object' || Array.isArray(entry.oauth)) throw new McpConfigError(`mcp.json server ${name}.oauth must be an object`);
      for (const key of Object.keys(entry.oauth)) {
        if (!OAUTH_FIELDS.has(key)) throw new McpConfigError(`mcp.json server ${name}.oauth has an unknown field: ${key}`);
      }
    }
    for (const exposure of [entry.exposure, ...Object.values(entry.toolExposure ?? {})]) {
      if (exposure !== undefined && !EXPOSURES.has(exposure)) throw new McpConfigError(`mcp.json server ${name} has an unknown exposure: ${String(exposure).slice(0, 40)}`);
    }
    if (entry.toolExposure !== undefined && (!entry.toolExposure || typeof entry.toolExposure !== 'object' || Array.isArray(entry.toolExposure))) {
      throw new McpConfigError(`mcp.json server ${name}.toolExposure must be an object`);
    }
    if (entry.timeout !== undefined && (!Number.isSafeInteger(entry.timeout) || entry.timeout < 1 || entry.timeout > 600)) {
      throw new McpConfigError(`mcp.json server ${name}.timeout must be an integer from 1 to 600 seconds`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new McpConfigError(`mcp.json server ${name}.enabled must be a boolean`);
    if (entry.description !== undefined && typeof entry.description !== 'string') throw new McpConfigError(`mcp.json server ${name}.description must be a string`);

    const checked = validateMcpServerConfig(name, entry);
    if (checked.kind === 'invalid') throw new McpConfigError(`mcp.json server ${name}: ${checked.error}`);
    const expanded = checked.kind === 'stdio'
      ? {
        ...checked.config,
        command: noReferences(checked.config.command, `mcp.json server ${name}.command`),
        args: (checked.config.args ?? []).map((arg, index) => noReferences(arg, `mcp.json server ${name}.args[${index}]`)),
        ...(checked.config.cwd !== undefined && { cwd: noReferences(checked.config.cwd, `mcp.json server ${name}.cwd`) }),
        env: expandRecord(checked.config.env, env, `mcp.json server ${name}.env`, referencedEnv),
      }
      : {
        ...checked.config,
        url: noReferences(String(checked.config.url), `mcp.json server ${name}.url`),
        headers: expandRecord(checked.config.headers, env, `mcp.json server ${name}.headers`, referencedEnv),
      };
    for (const value of Object.values(expanded.env ?? expanded.headers ?? {})) secrets.add(value);
    const oauth = entry.oauth === undefined ? undefined : {
      ...(entry.oauth.clientId !== undefined && { clientId: expandValue(String(entry.oauth.clientId), env, referencedEnv) }),
      ...(entry.oauth.clientSecret !== undefined && { clientSecret: expandValue(String(entry.oauth.clientSecret), env, referencedEnv) }),
      ...(entry.oauth.scope !== undefined && { scope: String(entry.oauth.scope) }),
      ...(entry.oauth.authServerMetadataUrl !== undefined && { authServerMetadataUrl: String(entry.oauth.authServerMetadataUrl) }),
    };
    if (oauth?.clientSecret) secrets.add(oauth.clientSecret);
    parsed.set(name, {
      name, kind: checked.kind, description: checked.config.description, enabled: entry.enabled !== false,
      timeoutMs: (entry.timeout ?? 60) * 1000, exposure: entry.exposure ?? 'direct',
      toolExposure: entry.toolExposure ?? {}, config: expanded, oauth,
    });
  }
  return { servers: parsed, secrets, referencedEnv };
}

// The environment a stdio server runs with. It never inherits the worker's own, which holds the agent token and the
// provider key; only PATH-like basics and the values the operator referenced reach the child.
export function serverEnvironment(parsed, base) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
  return {
    ...Object.fromEntries(allowed.flatMap(name => (typeof base[name] === 'string' ? [[name, base[name]]] : []))),
    ...(parsed.config.env ?? {}),
  };
}

export const limits = { MAX_SERVERS, MAX_TOOLS_PER_SERVER, MAX_TOOLS };
