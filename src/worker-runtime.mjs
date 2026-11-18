import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { contentText, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, ProviderDoc } from '@earendil-works/pi-durable';

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
      if (cfg.relay && text.startsWith('fixture-tool:')) {
        if (messages.at(-1)?.role === 'toolResult') {
          return fauxAssistantMessage(messages.at(-1).isError ? 'Fixture tool failed' : 'Fixture tool succeeded');
        }
        try {
          const { name, args } = JSON.parse(text.slice('fixture-tool:'.length));
          return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
        } catch {
          return fauxAssistantMessage('Invalid fixture tool input');
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
  return { models, model: { provider: providerId, modelId }, thinkingLevel, apiKey };
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
    JSON.parse(json + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
