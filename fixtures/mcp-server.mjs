#!/usr/bin/env node
import { createRequire } from 'node:module';
// A minimal MCP server over stdio for tests: line-delimited JSON-RPC, tools that exercise text, images, errors,
// oversized output, environment isolation and read-only annotations.
const require = createRequire(import.meta.url);

const tools = [
  {
    name: 'echo',
    description: 'Echo the given text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'env',
    description: 'Report selected environment variables the server process sees',
    inputSchema: { type: 'object', properties: {} },
  },
  { name: 'image', description: 'Return a tiny PNG', inputSchema: { type: 'object', properties: {} } },
  { name: 'wide', description: 'Return a PNG larger than a model accepts', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Report a tool failure', inputSchema: { type: 'object', properties: {} } },
  { name: 'big', description: 'Return more text than a model should receive inline', inputSchema: { type: 'object', properties: {} } },
];

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// A 2400x1200 PNG, larger than a model's default image limits, so the worker's fit hook has something to resize.
function widePng(width = 2400, height = 1200) {
  const { crc32, deflateSync } = require('node:zlib');
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) raw.fill(0x40, row * stride + 1, (row + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function call(name, args) {
  if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${String(args?.text ?? '')}` }] };
  if (name === 'env') {
    const seen = {
      secret: process.env.MCP_TEST_SECRET ?? 'unset',
      token: process.env.MANOLO_AGENT_TOKEN ?? 'unset',
      path: process.env.PATH ? 'set' : 'unset',
    };
    return { content: [{ type: 'text', text: JSON.stringify(seen) }] };
  }
  if (name === 'image') return { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] };
  if (name === 'wide') return { content: [{ type: 'image', data: widePng().toString('base64'), mimeType: 'image/png' }] };
  if (name === 'fail') return { isError: true, content: [{ type: 'text', text: 'the fixture tool failed on purpose' }] };
  if (name === 'big') return { content: [{ type: 'text', text: `start-${'x'.repeat(40_000)}-end` }] };
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
}

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === undefined) continue; // a response to a server-initiated request, which this server never sends
    if (message.id === undefined) continue; // notification
    const { id, method, params } = message;
    if (method === 'initialize') {
      respond({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'manolo-fixture-mcp', version: '1.0.0' },
          instructions: 'Fixture MCP server: use echo to prove a round trip.',
        },
      });
    } else if (method === 'tools/list') {
      respond({ jsonrpc: '2.0', id, result: { tools } });
    } else if (method === 'tools/call') {
      respond({ jsonrpc: '2.0', id, result: call(params?.name, params?.arguments) });
    } else if (method === 'ping') {
      respond({ jsonrpc: '2.0', id, result: {} });
    } else {
      respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
