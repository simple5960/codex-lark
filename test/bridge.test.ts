import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, chunks, type MessageEvent } from '../src/bridge.ts';
import { State } from '../src/state.ts';
import { parseSecret } from '../src/secrets.ts';
import { codexEnvironment, type Runner } from '../src/runner.ts';
import type { Config } from '../src/config.ts';
import type { TaskCardFactory } from '../src/progress.ts';

function event(text: string, id = Math.random().toString(), user = 'ou_owner'): MessageEvent {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } };
}
async function setup(t: { after(fn: () => Promise<void>): void }, runner: Runner, startTask?: TaskCardFactory) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-lark-test-'));
  const state = new State(join(dir, 'state.json'));
  await state.load();
  const replies: string[] = [];
  const config: Config = { workspace: dir, statePath: state.path, allowed: new Set(['ou_owner']), timeout: 5000, sandbox: 'workspace-write', domain: 'lark', secretId: 'test', region: undefined, model: undefined };
  const bridge = new Bridge(config, state, runner, async (_, text) => { replies.push(text); }, startTask);
  t.after(async () => { await bridge.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { bridge, state, replies, config };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, '等待任务状态超时'); await tick(); }
}

test('未授权用户只能查询身份，群聊、机器人和畸形内容不触发执行', async t => {
  let calls = 0;
  const { bridge, replies } = await setup(t, { run: async () => { calls++; return 'done'; } });
  await bridge.receive(event('write files', 'a', 'ou_stranger'));
  await bridge.receive(event('/whoami', 'b', 'ou_stranger'));
  const group = event('do work'); group.message.chat_type = 'group';
  await bridge.receive(group);
  const bot = event('do work'); bot.sender.sender_type = 'app';
  await bridge.receive(bot);
  const bad = event('bad'); bad.message.content = '{}'; await bridge.receive(bad);
  assert.equal(calls, 0);
  assert.match(replies[1]!, /ou_stranger/);
});

test('去重、线程持久化和续聊；new 清除会话', async t => {
  const ids: (string | undefined)[] = [];
  const { bridge, state } = await setup(t, { run: async (_, id, hooks) => {
    ids.push(id); await hooks.onThread('thread-1'); return 'done';
  } });
  await bridge.receive(event('first', 'a')); await tick();
  await bridge.receive(event('first', 'a')); await tick();
  await bridge.receive(event('second', 'b')); await tick();
  assert.deepEqual(ids, [undefined, 'thread-1']);
  const restored = new State(state.path); await restored.load();
  assert.deepEqual(restored.data, state.data);
  await bridge.receive(event('/new')); assert.equal(Object.keys(state.data.threads).length, 0);
});

test('后台处理立即返回，并发互斥和取消仅限任务所有者', async t => {
  let calls = 0;
  const { bridge, replies, config } = await setup(t, { run: async (_, __, { signal }) => {
    calls++;
    await new Promise<void>((_, reject) => {
      if (signal.aborted) reject(new Error('abort'));
      else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    });
    return '';
  } });
  config.allowed.add('ou_other');
  await bridge.receive(event('long task')); await tick();
  await bridge.receive(event('/cancel', 'cancel-other', 'ou_other'));
  await bridge.receive(event('overlap')); assert.equal(calls, 1);
  assert.ok(replies.some(s => s.includes('正在执行任务')));
  await bridge.receive(event('/new')); assert.ok(replies.some(s => s.includes('先 /cancel')));
  await bridge.receive(event('/cancel')); await tick();
  assert.ok(replies.some(s => s === '任务已取消。已产生的文件修改会保留。'));
});

test('超时会中止任务并释放工作目录', async t => {
  const { bridge, config, replies } = await setup(t, { run: async (_, __, { signal }) => {
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
    return '';
  } });
  config.timeout = 10;
  await bridge.receive(event('long')); await tick();
  assert.ok(replies.some(s => s.includes('超时')));
  await bridge.receive(event('/status'));
  assert.match(replies.at(-1)!, /空闲/);
});

test('AWS Secret 字段校验与子进程凭据隔离', () => {
  assert.deepEqual(parseSecret('{"simple-codex-app-id":"id","simple-codex-app-secret":"secret"}'), { appId: 'id', appSecret: 'secret' });
  assert.throws(() => parseSecret('{"simple-codex-app-id":"id"}'));
  const env = codexEnvironment({ HOME: '/home/test', AWS_SECRET_ACCESS_KEY: 'secret', LARK_APP_SECRET: 'secret', OPENAI_API_KEY: 'secret' });
  assert.deepEqual(env, { HOME: '/home/test' });
});

test('长消息按 UTF-8 字节切分，保留中文和 emoji', () => {
  const text = '你好🙂'.repeat(5000);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(s => Buffer.byteLength(s) <= 12000));
});

test('任务开始、进度和最终结果通过同一张卡片交付，不额外回复最终结果', async t => {
  const updates: string[] = [];
  const finals: string[] = [];
  let initial = '';
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const { bridge, replies } = await setup(t, { run: async (_, __, hooks) => {
    hooks.onProgress?.({ step: '执行测试', output: '3 个测试通过', outputKind: 'text' });
    await blocked; return '**任务完成**';
  } }, async (id, text) => {
    assert.equal(id, 'live-task'); initial = text;
    return { update: text => { updates.push(text); }, finish: async text => { finals.push(text); } };
  });
  await bridge.receive(event('测试', 'live-task'));
  await until(() => updates.length === 1);
  assert.match(initial, /正在启动 Codex/);
  assert.match(updates[0]!, /3 个测试通过/);
  release(); await until(() => finals.length === 1);
  assert.match(finals[0]!, /✅ 任务完成/);
  assert.match(finals[0]!, /\*\*任务完成\*\*/);
  assert.deepEqual(replies, []);
});

test('取消、超时和失败均写回任务卡片的终态', async t => {
  for (const mode of ['cancel', 'timeout', 'failure']) await t.test(mode, async t => {
    const finals: string[] = [];
    let running = false;
    const { bridge, config } = await setup(t, { run: async (_, __, { signal }) => {
      running = true;
      if (mode === 'failure') throw new Error('failed');
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
      return '';
    } }, async () => ({ update: () => {}, finish: async text => { finals.push(text); } }));
    if (mode === 'timeout') config.timeout = 30;
    await bridge.receive(event('work'));
    await until(() => running);
    if (mode === 'cancel') await bridge.receive(event('/cancel'));
    await until(() => finals.length === 1);
    assert.match(finals[0]!, mode === 'cancel' ? /任务已取消/ : mode === 'timeout' ? /任务超时/ : /任务失败/);
  });
});

test('初始卡片创建失败时不执行无法观测的任务', async t => {
  let calls = 0;
  const { bridge, replies } = await setup(t, { run: async () => { calls++; return ''; } }, async () => { throw new Error('create failed'); });
  await bridge.receive(event('work'));
  await until(() => replies.length === 1);
  assert.equal(calls, 0);
  assert.match(replies[0]!, /失败/);
});
