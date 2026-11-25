import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkBlueprints } from '../src/work-blueprints.mjs';

const load = value => loadWorkBlueprints(JSON.stringify(value));
const review = { description: 'Review notes', instructions: 'Write a short summary.' };

test('work blueprints are optional and their revisions are content-addressed', () => {
  assert.equal(loadWorkBlueprints(undefined).size, 0);
  const a = load({ review }).get('review');
  const b = load({ review: { instructions: `${review.instructions}\r\n`, description: review.description } }).get('review');
  assert.deepEqual(a, b);
  assert.match(a.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(load({ review: { ...review, instructions: 'Write two paragraphs.' } }).get('review').revision, a.revision);
});

test('invalid blueprint sets fail closed without echoing input', () => {
  for (const raw of ['!', 'null', '[]', JSON.stringify({ 'bad ID': review }), JSON.stringify({
    review: { ...review, tools: ['bash'] },
  }), JSON.stringify({ review: { ...review, instructions: 'MARKER\0' } }),
  JSON.stringify({ review: { ...review, instructions: 'x'.repeat(4001) } }),
  JSON.stringify(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`b${i}`, review]))),
  ]) {
    assert.throws(() => loadWorkBlueprints(raw), error => error.message.includes('MANOLO_WORK_BLUEPRINTS') && !error.message.includes('MARKER'));
  }
});
