import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { contentText, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool, ProviderDoc, wrapTool } from '@earendil-works/pi-durable';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { WORK_TOOL_NAMES } from './work-sessions.mjs';

// Explicit API-key providers only. No OAuth, CLI credential stores, cloud profiles, or token files.
const PROVIDERS = new Map(Object.entries({
  anthropic: ['anthropicProvider', 'ANTHROPIC_API_KEY'],
  deepseek: ['deepseekProvider', 'DEEPSEEK_API_KEY'],
  google: ['googleProvider', 'GEMINI_API_KEY'],
  groq: ['groqProvider', 'GROQ_API_KEY'],
  mistral: ['mistralProvider', 'MISTRAL_API_KEY'],
  openai: ['openaiProvider', 'OPENAI_API_KEY'],
  'opencode-go': ['opencodeGoProvider', 'OPENCODE_API_KEY'],
  openrouter: ['openrouterProvider', 'OPENROUTER_API_KEY'],
  xai: ['xaiProvider', 'XAI_API_KEY'],
}));

export async function createWorkerModels(cfg, env) {
  if (cfg.mode === 'fixture') {
    const models = createModels();
    const faux = fauxProvider({ provider: 'manolo-fixture', models: [{ id: 'fixture', input: ['text'] }] });
    const inspectSetup = env.MANOLO_FIXTURE_INSPECT_SETUP === '1';
    const answer = async ({ messages }, options) => {
      if (cfg.fixtureDelay) await sleep(cfg.fixtureDelay, undefined, { signal: options?.signal });
      const inputs = messages.filter(message => message.role === 'user').map(message => contentText(message.content));
      const text = inputs.at(-1) ?? '';
      if (inspectSetup && text === 'fixture:setup') {
        const system = getCurrentSystemMessage(messages);
        // Inspect what arrived at the fixture provider, without echoing prompt text, env or auth options.
        const instructionsSha256 = createHash('sha256').update(system?.sections?.instructions ?? '').digest('hex');
        const tools = system?.toolsAdded?.map(tool => tool.name) ?? [];
        return fauxAssistantMessage(JSON.stringify({ instructionsSha256, tools }));
      }
      if (text === 'fixture:history') return fauxAssistantMessage(JSON.stringify(inputs.slice(0, -1)));
      if (text === 'fixture:fail') {
        return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Fixture failure' });
      }
      if (text.startsWith('fixture-tool:')) {
        try {
          const { name, args } = JSON.parse(text.slice('fixture-tool:'.length));
          if (cfg.relay || WORK_TOOL_NAMES.includes(name) || name === 'list_mcp_tools' || name === 'call_mcp_tool') {
            if (messages.at(-1)?.role === 'toolResult') {
              return fauxAssistantMessage(messages.at(-1).isError ? 'Fixture tool failed' : 'Fixture tool succeeded');
            }
            return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
          }
        } catch {
          if (cfg.relay) return fauxAssistantMessage('Invalid fixture tool input');
        }
      }
      return fauxAssistantMessage(`Fixture: ${text}`);
    };
    const provider = { ...faux.provider };
    for (const method of ['stream', 'streamSimple']) {
      provider[method] = (...args) => {
        // The faux provider shifts its queue synchronously at stream creation, before it calls the factory.
        faux.appendResponses([answer]);
        return faux.provider[method](...args);
      };
    }
    models.setProvider(provider);
    return { models, model: { provider: provider.id, modelId: 'fixture' } };
  }
  const providerId = env.MANOLO_PROVIDER;
  const modelId = env.MANOLO_MODEL;
  const [factory, keyName] = PROVIDERS.get(providerId) ?? [];
  const apiKey = factory && env[keyName]?.trim();
  if (!apiKey || !modelId) throw new Error('Provider configuration missing');
  const models = createModels({
    authContext: { env: async name => name === keyName ? apiKey : undefined, fileExists: async () => false },
  });
  const provider = (await import(`@earendil-works/pi-ai/providers/${providerId}`))[factory]();
  models.setProvider({ ...provider, auth: { apiKey: provider.auth.apiKey } });
  const catalogModel = models.getModel(providerId, modelId);
  if (!catalogModel || (await models.checkAuth(providerId))?.type !== 'api_key') {
    throw new Error('Unsupported model or missing key');
  }
  const thinkingLevel = env.MANOLO_THINKING_LEVEL || (providerId === 'opencode-go' && modelId === 'deepseek-v4.1-flash' ? 'high' : undefined);
  if (thinkingLevel && !getSupportedThinkingLevels(catalogModel).includes(thinkingLevel)) {
    throw new Error('Unsupported thinking level');
  }
  return { models, model: { provider: providerId, modelId }, thinkingLevel, apiKey, credentialEnv: keyName };
}

function schema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const textSchema = maxLength => ({ type: 'string', minLength: 1, maxLength });
const inboxSchema = schema({ to: idSchema, text: textSchema(4000) });
const draftSchema = schema({
  title: textSchema(120),
  widgets: { type: 'array', maxItems: 20, items: schema({ kind: { type: 'string', enum: ['heading', 'note'] }, text: textSchema(2000) }) },
});
function boundedText(value, limit) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}
function hasFields(value, ...fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

async function readRelayJson(response) {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error('unexpected relay response');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error('relay response too large');
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// File and shell tools for the worker's own workspace. The shell gets an allowlist of the worker's environment, so a
// new credential name cannot leak by default; `env` adds names the operator wants available. This is not a sandbox.
// The process can still read /proc/self/environ and run as the container's user.
export const DEFAULT_BASH_TIMEOUT_SECONDS = 1800;
export const BASH_ENV_NAMES = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
export function installCodingTools(registry, { images, env = [], timeoutSeconds = DEFAULT_BASH_TIMEOUT_SECONDS }) {
  const names = new Set([...BASH_ENV_NAMES, ...env]);
  const visibleEnv = () => Object.fromEntries([...names].flatMap(name => {
    const value = process.env[name];
    return typeof value === 'string' ? [[name, value]] : [];
  }));
  const bash = createBashTool({ prepare(execution) { execution.env = visibleEnv(); execution.inheritEnv = false; } });
  registry.install(defineExtension({
    name: 'coding-tools',
    tools: [createReadTool({ images }), createWriteTool(), createEditTool(), bash],
    // A turn waits on a command with no timeout, so every call gets one even when the model omits it.
    wraps: [wrapTool(createBashTool(), tool => ({
      ...tool,
      execute: (args, api, context) => tool.execute({ ...args, timeout: args.timeout ?? timeoutSeconds }, api, context),
    }))],
  }));
}

export const RuntimeAccess = defineDoc({
  kind: 'manolo.runtime-access', scope: 'conversation', version: 1, initial: () => ({ targets: [] }), checkpointWhen: () => true,
});

export function installRuntimeTools(registry, { relay, token }) {
  if (!relay) return;
  const exec = defineTool({
    name: 'runtime_exec', callers: ['model'], replay: 'unsafe',
    description: 'Run a shell command on a paired runtime listed in this turn’s instructions. Use ordinary bash for the pod. Relative cwd is resolved on the runtime under its home directory. Never retry an unknown outcome automatically.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['target', 'command'], properties: {
        target: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        command: textSchema(8000), cwd: textSchema(4096),
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120 },
      },
    },
    async execute({ target, command, cwd, timeoutSeconds = 30 }, api, context) {
      const access = await api.snapshot(RuntimeAccess, api.conversationId, context);
      if (!access?.turn || !access.targets.includes(target)) throw new Error('This runtime is not available for this turn.');
      const timeoutMs = timeoutSeconds * 1000;
      const deadline = AbortSignal.timeout(timeoutMs + 5000);
      const signal = context.abortSignal ? AbortSignal.any([deadline, context.abortSignal]) : deadline;
      let result;
      try {
        const response = await fetch(`${relay}/v1/runtime/execute`, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ turn: access.turn, target, command, cwd, timeoutMs }),
        });
        if (response.status >= 400 && response.status < 500) {
          await response.body?.cancel();
          result = { status: 'denied' };
        } else result = await readRelayJson(response);
      } catch { result = { status: 'unknown' }; }
      if (result?.status === 'denied') throw new Error('Runtime request was denied before dispatch.');
      if (result?.status === 'unavailable') throw new Error(`${target} is offline or busy; command was not dispatched.`);
      if (result?.status !== 'completed' || typeof result.output !== 'string' || result.output.length > 8000 ||
          typeof result.timedOut !== 'boolean' || (result.exitCode !== null && !Number.isSafeInteger(result.exitCode))) {
        throw new Error(`${target}: command outcome unknown. Do not retry automatically.`);
      }
      const status = result.timedOut ? 'timed out after it may have run; do not retry automatically' : `exit status ${result.exitCode ?? 'unknown'}`;
      return {
        output: [{ type: 'text', text: `[${target}] ${status}\n${result.output}` }],
        isError: result.timedOut || result.exitCode !== 0,
      };
    },
  });
  registry.install(defineExtension({ name: 'manolo-runtimes', tools: [exec] }));
  return exec;
}

export function installRelayTools(registry, { relay, agentId, token }) {
  if (!relay) return;
  function relayTool(name, description, parameters, method, path, shape) {
    return defineTool({ name, description, parameters, replay: 'unsafe', async execute(args, api, context) {
      const body = shape(args);
      if (!body) throw new Error('Invalid tool arguments');
      const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId;
      if (!sessionId) throw new Error('Missing relay call identity');
      const key = createHash('sha256').update(JSON.stringify([agentId, sessionId, api.taskId])).digest('hex');
      const timeout = AbortSignal.timeout(8_000);
      const signal = context.abortSignal ? AbortSignal.any([timeout, context.abortSignal]) : timeout;
      try {
        const response = await fetch(relay + path, {
          method, redirect: 'error', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key },
          body: JSON.stringify(body),
        });
        await readRelayJson(response);
      } catch {
        // A timeout, disconnect, or invalid receipt may happen after the relay committed the operation.
        throw new Error('Relay operation outcome unknown; do not retry automatically.');
      }
      // Do not send arbitrary remote response content to the model or persist it as a tool result.
      return { output: [{ type: 'text', text: 'Accepted by Manolo relay.' }] };
    } });
  }
  registry.install(defineExtension({
    name: 'manolo-relay',
    tools: [
      relayTool('send_inbox', 'Send a text message to a Manolo agent inbox. The relay decides which recipients are allowed.',
        inboxSchema, 'POST', '/v1/inbox', args => {
          if (hasFields(args, 'to', 'text') && typeof args.to === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(args.to) &&
              boundedText(args.text, 4000)) return { to: args.to, text: args.text };
        }),
      relayTool('write_dashboard_draft', 'Replace your dashboard draft (does not publish). Use plain text only.',
        draftSchema, 'PUT', '/v1/dashboard/draft', args => {
          if (!hasFields(args, 'title', 'widgets') || !boundedText(args.title, 120) || !Array.isArray(args.widgets) || args.widgets.length > 20) return;
          if (!args.widgets.every(widget => hasFields(widget, 'kind', 'text') &&
              ['note', 'heading'].includes(widget.kind) && boundedText(widget.text, 2000))) return;
          return { title: args.title, widgets: args.widgets.map(({ kind, text }) => ({ kind, text })) };
        }),
    ],
  }));
}
