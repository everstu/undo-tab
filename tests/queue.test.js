import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueue } from '../shared/queue.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('任务按入队顺序串行执行', async () => {
  const enqueue = createQueue();
  const order = [];
  const first = enqueue(async () => {
    order.push('a-start');
    await delay(15);
    order.push('a-end');
    return 1;
  });
  const second = enqueue(async () => {
    order.push('b-start');
    return 2;
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
  assert.deepEqual(results, [1, 2]);
});

test('前一个任务失败不阻断后续任务', async () => {
  const enqueue = createQueue();
  const failing = enqueue(async () => {
    throw new Error('boom');
  });
  const following = enqueue(async () => 'ok');
  await assert.rejects(failing, /boom/);
  assert.equal(await following, 'ok');
});

test('并发读改写不会交错', async () => {
  const enqueue = createQueue();
  let value = 0;
  const tasks = Array.from({ length: 20 }, (_, index) =>
    enqueue(async () => {
      const read = value;
      await delay(1);
      value = read + 1;
      return index;
    }),
  );
  await Promise.all(tasks);
  assert.equal(value, 20);
});
