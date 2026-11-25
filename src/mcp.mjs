import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createMcpToolName, limitMcpContent, McpClient, mcpNamespace, normalizeMcpInputSchema, StdioTransport,
  StreamableHttpTransport, toLlmContent,
} from '@earendil-works/pi-mcp';
import { McpOAuthAuthorizationRequiredError } from '@earendil-works/pi-mcp/oauth';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode';
import { MCP_FILE, McpConfigError, exposureFor, limits, parseMcpConfig, serverEnvironment } from './mcp-config.mjs';
import { createMcpOAuth } from './mcp-oauth.mjs';

const MAX_IMAGE_BASE64 = 4_000_000;
const MAX_SAVED_BYTES = 1_000_000;
const MAX_SAVED_PER_CALL = 4_000_000;
const EMPTY = '{\n  "mcpServers": {}\n}\n';
const clip = (value, limit) => (value.length > limit ? `${value.slice(0, limit)}…` : value);

/**
 * MCP servers for one agent. The configuration is a file on the agent's own volume, so the owner (or the agent) can
 * add, remove or sign in to a server without a commit or a restart: this manager reconciles the live registry, and the
 * harness picks the new tool set up on the next model request. A server that is unreachable costs its tools, not the
 * worker; a configuration that does not parse is reported and the previous set keeps running.
 */
export async function createMcp({
  dataDir, workspaceDir, env = process.env, registry, log = console,
  publicUrl = env.MANOLO_PUBLIC_URL, seed = env.MANOLO_MCP_SERVERS, codemode = false,
}) {
  const configPath = join(dataDir, MCP_FILE);
  const outputDir = join(workspaceDir, 'mcp');
  const oauth = createMcpOAuth({ statePath: join(dataDir, 'mcp-auth.json'), publicUrl, log });
  const clients = new Map(); // server name -> { client, transport, tools, extension, ... }
  const extensions = new Map(); // server name -> installed extension
  let codemodeExtension;
  let toolSearch;
  let sandbox;
  let applied = '';
  let config = new Map();
  let secrets = new Set();
  let referencedEnv = new Set();
  let error;
  let timer;
  let stopped = false;

  // Full text or a binary resource the relay would truncate is written where the agent's own `read` reaches it.
  function outputSaver() {
    let saved = 0;
    let bytes = 0;
    return async (data, extension) => {
      saved += 1;
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      bytes += size;
      if (size > MAX_SAVED_BYTES || bytes > MAX_SAVED_PER_CALL) throw new Error('The MCP result is too large to save');
      await mkdir(outputDir, { recursive: true });
      const name = `mcp-${Date.now().toString(36)}-${saved}${extension}`;
      await writeFile(join(outputDir, name), data, { mode: 0o600 });
      return `mcp/${name}`;
    };
  }

  function blocks(content) {
    const output = [];
    for (const block of content.slice(0, 8)) {
      if (block.type === 'text') output.push({ type: 'text', text: block.text });
      else if (block.type === 'image') {
        if (typeof block.data !== 'string' || block.data.length > MAX_IMAGE_BASE64) continue;
        if (!/^image\/(png|jpeg|gif|webp)$/.test(String(block.mimeType))) continue;
        output.push({ type: 'image', data: block.data, mimeType: block.mimeType });
      }
    }
    return output;
  }

  function buildTools(server, tools, taken) {
    const built = [];
    for (const tool of tools.slice(0, limits.MAX_TOOLS_PER_SERVER)) {
      const exposure = exposureFor(server, tool.name);
      if (exposure === 'hidden') continue;
      if (taken.size >= limits.MAX_TOOLS) {
        log.error(`MCP ${server.name}: stopped after ${limits.MAX_TOOLS} tools; raise the limit or filter with toolExposure`);
        break;
      }
      const name = createMcpToolName(server.name, tool.name, candidate => taken.has(candidate));
      if (taken.has(name)) continue;
      taken.add(name);
      const description = clip(`${server.name}: ${tool.description ?? tool.title ?? tool.name}`.trim(), 1800);
      built.push(defineTool({
        name,
        description,
        parameters: normalizeMcpInputSchema(tool.inputSchema),
        callers: exposure === 'codemode' ? ['tools'] : ['model', 'tools'],
        ...(exposure === 'deferred' && { deferred: true }),
        // A read-only hint is the server's own claim; anything else may have side effects and must not be replayed.
        replay: tool.annotations?.readOnlyHint === true ? 'safe' : 'unsafe',
        async execute(args, _api, context) {
          const entry = clients.get(server.name);
          if (!entry) throw new Error(`The ${server.name} MCP server is not connected`);
          const timeout = AbortSignal.timeout(Math.min(server.timeoutMs, 120_000));
          const signal = context.abortSignal ? AbortSignal.any([timeout, context.abortSignal]) : timeout;
          const saveOutput = outputSaver();
          let result;
          try {
            result = await entry.client.callTool(tool.name, args, { signal });
          } catch (cause) {
            throw new Error(`MCP ${server.name}/${tool.name} failed: ${clip(String(cause?.message ?? cause), 300)}`);
          }
          const limited = await limitMcpContent(toLlmContent(result), saveOutput);
          const output = blocks(limited.content);
          if (limited.fullOutputPath) output.push({ type: 'text', text: `Full output: ${limited.fullOutputPath}` });
          if (output.length === 0) output.push({ type: 'text', text: 'The server returned no content.' });
          return { output, ...(result.isError === true && { isError: true }) };
        },
      }));
    }
    return built;
  }

  async function connect(server) {
    const auth = server.kind === 'http' ? oauth.authFor(server) : undefined;
    const client = new McpClient({ name: 'manolo', version: '1', requestTimeoutMs: server.timeoutMs });
    const transport = server.kind === 'stdio'
      ? new StdioTransport({
        command: server.config.command,
        args: server.config.args ?? [],
        env: serverEnvironment(server, env),
        inheritEnv: false,
        stderr: 'pipe',
        onStderr: chunk => log.error(`MCP ${server.name} stderr: ${clip(chunk.trim(), 400)}`),
        ...(server.config.cwd && { cwd: server.config.cwd }),
      })
      : new StreamableHttpTransport({
        url: server.config.url,
        // Manolo's servers answer requests; the agent does not consume server-initiated notifications.
        openGetStream: false,
        ...(server.config.headers && { headers: server.config.headers }),
        ...(auth && { authProvider: auth }),
      });
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`did not answer within ${server.timeoutMs / 1000}s`)), server.timeoutMs).unref()),
      ]);
      return { client, transport, tools: await client.listTools(), instructions: client.instructions };
    } catch (failure) {
      await client.close().catch(() => {});
      throw failure;
    }
  }

  async function installServer(server, connected) {
    const snapshot = registry.snapshot();
    const taken = new Set(snapshot.tools().map(entry => entry.tool.name));
    const tools = buildTools(server, connected.tools, taken);
    // The extension's namespace is what code mode and tool search group these tools under; it also lets the section
    // name a server whose tools are not loaded yet.
    const extension = defineExtension({
      name: `mcp:${server.name}`,
      namespace: {
        name: mcpNamespace(server.name),
        description: server.description ?? `Tools of the ${server.name} MCP server`,
        ...(connected.instructions && { instructions: connected.instructions }),
      },
      tools,
    });
    registry.install(extension);
    extensions.set(server.name, extension);
    return tools.length;
  }

  async function drop(serverName) {
    const extension = extensions.get(serverName);
    if (extension) {
      registry.uninstall(extension);
      extensions.delete(serverName);
    }
    const entry = clients.get(serverName);
    if (entry) {
      clients.delete(serverName);
      await entry.client.close().catch(() => {});
    }
  }

  // Code mode and deferred tools are offered only when a connected server needs them. Namespaces come from the server
  // extensions themselves, so this only decides whether the `codemode` and `tool_search` tools exist.
  async function syncCodemode() {
    const wantsCodemode = [...extensions.values()]
      // Only a server that asks for code mode turns the sandbox on; direct tools stay reachable from a script too.
      .some(extension => extension.tools?.some(tool => tool.callers?.length === 1 && tool.callers[0] === 'tools'));
    const deferred = [...extensions.values()].some(extension => extension.tools?.some(tool => tool.deferred));
    if (deferred && !toolSearch) {
      toolSearch = createToolSearchExtension();
      registry.install(toolSearch);
    } else if (!deferred && toolSearch) {
      registry.uninstall(toolSearch);
      toolSearch = undefined;
    }
    // `codemode: true` keeps the tool available for an agent that wants scripts over its standard tools even when no
    // MCP server asks for code mode; otherwise it follows the configured exposures.
    if (!wantsCodemode && !codemode) {
      if (codemodeExtension) { registry.uninstall(codemodeExtension); codemodeExtension = undefined; }
      return;
    }
    sandbox ??= new InlineCodemodeSandbox({ wasm: await loadQuickJSWasm() });
    if (codemodeExtension) registry.uninstall(codemodeExtension);
    codemodeExtension = createCodemodeExtension({ sandbox, models: false });
    registry.install(codemodeExtension);
  }

  const status = () => [...config.values()].map(server => {
    const state = !server.enabled ? 'disabled' : clients.has(server.name) ? 'connected' : (server.state ?? 'unreachable');
    return {
      name: server.name, kind: server.kind, enabled: server.enabled, state,
      tools: extensions.get(server.name)?.tools?.length ?? 0,
      ...(server.description && { description: server.description }),
      ...(server.error && { error: server.error }),
      ...(oauth.pendingFor(server.name) && {
        authUrl: oauth.pendingFor(server.name).authorizationUrl,
        authState: oauth.pendingFor(server.name).state,
      }),
    };
  });

  async function parse(text) {
    const parsed = parseMcpConfig(text, env);
    secrets = parsed.secrets;
    referencedEnv = parsed.referencedEnv;
    return parsed.servers;
  }

  async function apply(text, { reconnect = new Set() } = {}) {
    const next = await parse(text);
    const previous = config;
    config = next;
    for (const [name, server] of next) {
      const before = previous.get(name);
      const signature = JSON.stringify([server.kind, server.config, server.enabled]);
      // A sign-in or a manual retry asks for this server to be dialed again even though its entry did not change.
      if (before && before.signature === signature && !reconnect.has(name)) {
        server.state = before.state;
        server.error = before.error;
        continue;
      }
      if (before && before.signature !== signature) await drop(name);
      server.signature = signature;
      if (!server.enabled) continue;
      try {
        const connected = await connect(server);
        clients.set(name, connected);
        server.state = 'connected';
        server.error = undefined;
        await installServer(server, connected);
        log.log(`MCP ${name}: ${extensions.get(name)?.tools?.length ?? 0} tools (${server.kind})`);
      } catch (failure) {
        if (failure instanceof McpOAuthAuthorizationRequiredError) {
          clients.delete(name);
          server.state = 'sign-in';
          server.error = 'Sign-in required';
          log.log(`MCP ${name}: sign-in required (${failure.message})`);
          if (oauth.enabled) await oauth.begin(server).catch(cause => log.error(`MCP ${name}: ${cause.message}`));
        } else {
          clients.delete(name);
          server.state = 'unreachable';
          server.error = clip(String(failure?.message ?? failure), 300);
          log.error(`MCP ${name}: ${server.error}`);
        }
      }
    }
    for (const name of [...clients.keys(), ...extensions.keys()]) if (!next.has(name)) await drop(name);
    for (const [name, before] of previous) if (!next.has(name)) await oauth.forget(before).catch(() => {});
    await syncCodemode();
    applied = hash(text);
    return { changed: true };
  }

  const hash = text => createHash('sha256').update(text).digest('hex');

  async function readConfigText() {
    try {
      return await readFile(configPath, 'utf8');
    } catch {
      let initial = EMPTY;
      if (typeof seed === 'string' && seed.trim() !== '') {
        // A bad seed is reported, but it never becomes the working file the owner has to repair by hand.
        try {
          parseMcpConfig(seed, env);
          initial = `${seed.trimEnd()}\n`;
        } catch (failure) {
          log.error(`Ignoring MANOLO_MCP_SERVERS seed: ${failure.message}`);
        }
      }
      await writeFile(configPath, initial, { mode: 0o600 });
      return initial;
    }
  }

  async function reload({ force = false, reconnect } = {}) {
    const text = await readConfigText();
    if (!force && hash(text) === applied) return { changed: false };
    try {
      const result = await apply(text, { reconnect });
      error = undefined;
      return result;
    } catch (failure) {
      error = failure instanceof McpConfigError ? failure.message : 'mcp.json could not be applied';
      log.error(`MCP configuration rejected: ${error}`);
      return { changed: false, error };
    }
  }

  async function setConfig(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 128 * 1024) throw new McpConfigError('mcp.json is too large');
    parseMcpConfig(text, env); // refuse before writing, so a bad edit never replaces a working file
    await writeFile(configPath, text, { mode: 0o600 });
    return reload({ force: true });
  }

  async function signIn(name) {
    const server = config.get(name);
    if (!server) throw new Error('Unknown MCP server');
    const started = await oauth.begin(server);
    if (started.kind === 'authorized') {
      await reload({ force: true, reconnect: new Set([name]) });
      return { kind: 'authorized' };
    }
    return started;
  }

  async function completeSignIn(state, response) {
    const name = await oauth.complete(state, response);
    const server = config.get(name);
    if (server) server.state = 'unreachable';
    await reload({ force: true, reconnect: new Set([name]) });
    return { server: name };
  }

  async function start() {
    await mkdir(dataDir, { recursive: true });
    await reload({ force: true });
  }

  function watch(intervalMs = 5000) {
    let last;
    timer = setInterval(async () => {
      if (stopped) return;
      try {
        const info = await stat(configPath);
        const stamp = `${info.mtimeMs}:${info.size}`;
        if (stamp === last) return;
        last = stamp;
        await reload();
      } catch { /* the file is being replaced; the next pass reads it */ }
    }, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    for (const name of [...clients.keys()]) await drop(name);
    for (const extension of extensions.values()) registry.uninstall(extension);
    extensions.clear();
    if (codemodeExtension) registry.uninstall(codemodeExtension);
    if (toolSearch) registry.uninstall(toolSearch);
  }

  const configText = () => readFile(configPath, 'utf8');

  return {
    start, stop, watch, reload, setConfig, signIn, completeSignIn, status, configText,
    get secrets() { return [...secrets]; },
    get referencedEnv() { return [...referencedEnv]; },
    get configError() { return error; },
  };
}
