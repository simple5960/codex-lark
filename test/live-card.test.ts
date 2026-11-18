import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCardFactory } from '../src/live-card.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < end, '等待异步卡片请求超时');
    await delay(2);
  }
}
const markdown = (content: string) => JSON.parse(content).body.elements[0].content as string;

test('任务只创建一张共享卡片，合并中间进度，并在同一消息上写入最终结果', async () => {
  let creates = 0;
  const writes: string[] = [];
  const card = await createTaskCardFactory(async (id, content) => {
    creates++;
    assert.equal(id, 'om_user');
    assert.equal(JSON.parse(content).config.update_multi, true);
    return { code: 0, data: { message_id: 'om_card' } };
  }, async (id, content) => {
    assert.equal(id, 'om_card'); writes.push(markdown(content)); return { code: 0 };
  }, async () => assert.fail('正常任务不发送额外消息'), 20)('om_user', '开始');
  card.update('进展1'); card.update('进展2'); card.update('进展3');
  await until(() => writes.length === 1);
  assert.deepEqual(writes, ['进展3']);
  await card.finish('最终结果');
  card.update('过期进度');
  await delay(30);
  assert.equal(creates, 1);
  assert.deepEqual(writes, ['进展3', '最终结果']);
});

test('最终状态等待进行中的更新，未发送的进度不会在结束后覆盖结果', async () => {
  const writes: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const card = await createTaskCardFactory(async () => ({ code: 0, data: { message_id: 'om_card' } }), async (_, content) => {
    writes.push(markdown(content));
    if (writes.length === 1) await blocked;
    return { code: 0 };
  }, async () => assert.fail('不应回退'), 1)('om_user', '开始');
  card.update('旧进度'); await until(() => writes.length === 1);
  card.update('未发送的新进度');
  const done = card.finish('已取消');
  assert.deepEqual(writes, ['旧进度']);
  release(); await done;
  assert.deepEqual(writes, ['旧进度', '已取消']);
  await card.finish('重复结束');
  assert.equal(writes.length, 2);
});

test('中间更新失败不阻断任务，下一次更新仍然成功', async () => {
  let calls = 0;
  const writes: string[] = [];
  const card = await createTaskCardFactory(async () => ({ code: 0, data: { message_id: 'om_card' } }), async (_, content) => {
    calls++;
    if (calls === 1) throw new Error('network');
    writes.push(markdown(content)); return { code: 0 };
  }, async () => assert.fail('不应回退'), 1)('om_user', '开始');
  card.update('旧进度'); await until(() => calls === 1);
  card.update('恢复进度'); await until(() => writes.length === 1);
  await card.finish('完成');
  assert.deepEqual(writes, ['恢复进度', '完成']);
});

test('终态更新失败时仍交付完整结果；创建失败不返回无效卡片', async () => {
  const fallback: string[] = [];
  const card = await createTaskCardFactory(async () => ({ code: 0, data: { message_id: 'om_card' } }), async () => ({ code: 1 }), async (id, text) => {
    assert.equal(id, 'om_user'); fallback.push(text);
  })('om_user', '开始');
  await card.finish('完整结果');
  assert.deepEqual(fallback, ['完整结果']);
  await assert.rejects(createTaskCardFactory(async () => ({ code: 0 }), async () => ({ code: 0 }), async () => {})('om_user', '开始'));
});

test('超长最终结果主卡保留首段，其余段落完整交付', async () => {
  const remainder: string[] = [];
  const source = '中文🙂'.repeat(8000);
  let first = '';
  const card = await createTaskCardFactory(async () => ({ code: 0, data: { message_id: 'om_card' } }), async (_, content) => {
    assert.ok(Buffer.byteLength(content) < 30000);
    first = markdown(content).split('\n\n> 结果较长')[0]!; return { code: 0 };
  }, async (_, text) => { remainder.push(text); })('om_user', '开始');
  await card.finish(source);
  assert.equal(first + remainder.join(''), source);
});

test('重启后复用保存的卡片 ID，不重新创建消息', async () => {
  const writes: string[] = [];
  const card = await createTaskCardFactory(async () => { assert.fail('不能创建新卡片'); }, async (id, content) => {
    assert.equal(id, 'om_saved'); writes.push(markdown(content)); return { code: 0 };
  }, async () => assert.fail('不应回退'), 1)('om_user', '恢复中', 'om_saved');
  assert.equal(card.messageId, 'om_saved');
  await card.finish('中断通知');
  assert.deepEqual(writes, ['中断通知']);
});
