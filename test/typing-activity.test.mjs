import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createTypingActivity } from '../src/typing-activity.mjs';

async function until(check) {
  for (let i = 0; i < 200 && !check(); i++) await sleep(5);
  assert.ok(check(), 'expected typing pulse');
}

test('typing is delayed, refreshed per chat, bounded, and stopped on completion and shutdown', async t => {
  const lifecycle = new AbortController();
  t.after(() => lifecycle.abort());
  const calls = [];
  const activity = createTypingActivity(({ chatId }) => calls.push(chatId), lifecycle.signal,
    { initial: 20, refresh: 10, limit: 1 });
  activity.begin('fast');
  activity.end('fast');
  activity.begin('slow');
  activity.begin('slow');
  activity.begin('over-limit');
  await until(() => calls.length >= 2);
  assert.ok(calls.every(id => id === 'slow'));
  activity.end('slow');
  const count = calls.length;
  await sleep(30);
  assert.equal(calls.length, count);
  activity.begin('shutdown');
  lifecycle.abort();
  await sleep(30);
  assert.equal(calls.length, count);
});

test('a typing connector failure backs off and does not stop work', async t => {
  const lifecycle = new AbortController();
  t.after(() => lifecycle.abort());
  let calls = 0;
  const activity = createTypingActivity(() => {
    if (++calls === 1) throw Error('not supported by the old connector');
  }, lifecycle.signal, { initial: 1, refresh: 1, backoff: 100 });
  activity.begin('slow');
  await until(() => calls === 1);
  await sleep(15);
  assert.equal(calls, 1);
  await until(() => calls >= 2);
  activity.end('slow');
});
