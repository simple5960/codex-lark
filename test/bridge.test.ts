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
import type { ReferenceReader } from '../src/references.ts';
import type { TaskWorkspaces } from '../src/workspaces.ts';

function event(text: string, id = Math.random().toString(), user = 'ou_owner'): MessageEvent {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < end, '等待任务状态超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function setup(t: { after(fn: () => Promise<void>): void }, runner: Runner, factory?: TaskCardFactory, reader: ReferenceReader = async () => 'quoted text') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-lark-test-'));
  const state = new State(join(dir, 'state.json')); await state.load();
  const replies: { id: string; text: string }[] = [];
  const finals: string[] = []; const updates: string[] = [];
  const config: Config = {
    workspace: dir, statePath: state.path, allowed: new Set(['ou_owner']), timeout: 5000,
    sandbox: 'workspace-write', domain: 'lark', secretId: 'test', region: undefined, model: undefined,
    codexExecutable: 'codex', parallel: 2, queued: 20, worktreeRoot: join(dir, 'worktrees'),
  };
  const workspaces: TaskWorkspaces = { prepare: async task => ({ workspace: task.workspace || join(dir, task.id), branch: task.branch || `codex/task-${task.id}` }) };
  const startTask: TaskCardFactory = factory ?? (async (id, text, existing) => {
    updates.push(text);
    return { messageId: existing || `card-${id}`, update: text => { updates.push(text); }, finish: async text => { finals.push(text); } };
  });
  const reply = async (id: string, text: string) => { replies.push({ id, text }); };
  const bridge = new Bridge(config, state, runner, reply, startTask, workspaces, reader);
  await bridge.start();
  t.after(async () => { await bridge.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { bridge, state, replies, config, finals, updates, reply, startTask, workspaces };
}
const immediate: Runner = { run: async (_, __, hooks) => { await hooks.onThread('thread-1'); hooks.onProgress?.({ step: '执行测试', output: '测试通过', outputKind: 'text' }); return '**任务完成**'; } };
function blockedRunner() {
  const calls: { prompt: string; workspace: string | undefined; signal: AbortSignal; release: () => void; thread?: string }[] = [];
  const runner: Runner = { run: async (prompt, thread, hooks) => {
    await hooks.onThread(thread || `thread-${calls.length}`);
    await new Promise<void>((resolve, reject) => {
      calls.push({ prompt, workspace: hooks.workingDirectory, signal: hooks.signal, release: resolve, ...(thread ? { thread } : {}) });
      if (hooks.signal.aborted) reject(new Error('aborted'));
      else hooks.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return 'done';
  } };
  return { calls, runner };
}

test('权限、非聊天过滤、消息去重仍然生效', async t => {
  let calls = 0;
  const { bridge, replies, state } = await setup(t, { run: async () => { calls++; return 'done'; } });
  await bridge.receive(event('work', 'unauthorized', 'ou_stranger'));
  await bridge.receive(event('/whoami', 'identity', 'ou_stranger'));
  const group = event('work'); group.message.chat_type = 'thread'; await bridge.receive(group);
  const bot = event('work'); bot.sender.sender_type = 'app'; await bridge.receive(bot);
  const malformed = event('bad'); malformed.message.content = '{}'; await bridge.receive(malformed);
  assert.equal(calls, 0); assert.ok(replies.some(item => item.text.includes('ou_stranger')));
  await Promise.all([bridge.receive(event('work', 'same-id')), bridge.receive(event('work', 'same-id'))]);
  await until(() => calls === 1);
  assert.equal(Object.keys(state.data.tasks).length, 1);
});

test('两个任务真实重叠，目录和线程互不混用，第三个按序排队', async t => {
  const { calls, runner } = blockedRunner();
  const { bridge, state } = await setup(t, runner);
  await bridge.receive(event('/task A')); await bridge.receive(event('/task B')); await bridge.receive(event('/task C'));
  await until(() => calls.length === 2);
  assert.deepEqual(calls.map(item => item.prompt), ['A', 'B']);
  assert.notEqual(calls[0]!.workspace, calls[1]!.workspace);
  assert.equal(Object.values(state.data.tasks).filter(task => task.phase === 'queued').length, 1);
  calls[0]!.release(); await until(() => calls.length === 3);
  assert.equal(calls[2]!.prompt, 'C');
  assert.equal(calls[1]!.signal.aborted, false);
  calls[1]!.release(); calls[2]!.release();
});

test('普通消息忙时开新任务；显式续聊和回复旧卡片保留对应上下文', async t => {
  const inputs: { prompt: string; thread: string | undefined; workspace: string | undefined }[] = [];
  const { bridge, state, finals } = await setup(t, { run: async (prompt, thread, hooks) => {
    inputs.push({ prompt, thread, workspace: hooks.workingDirectory });
    await hooks.onThread(`thread-${inputs.length}`); return 'done';
  } });
  await bridge.receive(event('first', 'first')); await until(() => finals.length === 1);
  const first = Object.values(state.data.tasks)[0]!;
  await bridge.receive(event(`/continue ${first.id} second`)); await until(() => finals.length === 2);
  assert.equal(inputs[1]!.thread, 'thread-1'); assert.equal(inputs[1]!.workspace, inputs[0]!.workspace);
  await bridge.receive(event('/task separate', 'other')); await until(() => finals.length === 3);
  const reply = event('reply-to-first'); reply.message.parent_id = 'card-first';
  await bridge.receive(reply); await until(() => finals.length === 4);
  assert.equal(inputs[3]!.thread, 'thread-2'); assert.equal(inputs[3]!.workspace, inputs[0]!.workspace);
  assert.equal(Object.keys(state.data.tasks).length, 2);
});

test('忙时普通消息创建独立任务，同一任务不能重复并发续聊', async t => {
  const { calls, runner } = blockedRunner(); const { bridge, state, replies } = await setup(t, runner);
  await bridge.receive(event('A')); await until(() => calls.length === 1);
  const first = Object.values(state.data.tasks)[0]!;
  await bridge.receive(event('B')); await until(() => calls.length === 2);
  await bridge.receive(event(`/continue ${first.id} overlap`));
  assert.equal(Object.keys(state.data.tasks).length, 2);
  assert.ok(replies.some(item => item.text.includes('尚未结束')));
  calls.forEach(item => item.release());
});

test('指定取消不会影响其他任务，排队任务取消后不执行', async t => {
  const { calls, runner } = blockedRunner(); const { bridge, state, config, replies } = await setup(t, runner);
  config.allowed.add('ou_other');
  await bridge.receive(event('/task A')); await bridge.receive(event('/task B')); await bridge.receive(event('/task C'));
  await until(() => calls.length === 2);
  const tasks = Object.values(state.data.tasks);
  await bridge.receive(event('/cancel'));
  assert.ok(replies.some(item => item.text.includes('有多个任务')));
  await bridge.receive(event(`/cancel ${tasks[0]!.id}`, 'foreign', 'ou_other'));
  assert.equal(calls[0]!.signal.aborted, false);
  await bridge.receive(event(`/cancel ${tasks[2]!.id}`));
  assert.equal(tasks[2]!.phase, 'cancelled');
  await bridge.receive(event(`/cancel ${tasks[0]!.id}`));
  await until(() => tasks[0]!.phase === 'cancelled');
  assert.equal(calls[1]!.signal.aborted, false); assert.equal(calls.length, 2);
  calls[1]!.release();
});

test('队列上限生效，任务列表和结果仅对所有者可见', async t => {
  const { calls, runner } = blockedRunner(); const { bridge, state, config, replies } = await setup(t, runner);
  config.parallel = 1; config.queued = 1; config.allowed.add('ou_other');
  await bridge.receive(event('/task A')); await bridge.receive(event('/task B')); await bridge.receive(event('/task C'));
  await until(() => calls.length === 1);
  assert.equal(Object.keys(state.data.tasks).length, 2);
  assert.ok(replies.some(item => item.text.includes('队列已满')));
  await bridge.receive(event('/tasks', 'list')); assert.ok(replies.at(-1)!.text.includes('排队中'));
  await bridge.receive(event('/tasks', 'foreign-list', 'ou_other')); assert.ok(replies.at(-1)!.text.includes('尚无任务'));
  calls[0]!.release(); await until(() => calls.length === 2); calls[1]!.release();
});

test('旧会话沿用原目录和线程，new 不会取消已有任务', async t => {
  const { calls, runner } = blockedRunner(); const { bridge, state, config } = await setup(t, runner);
  const key = JSON.stringify([config.workspace, 'chat', 'ou_owner']);
  state.data.threads[key] = 'legacy-thread';
  await bridge.receive(event('continue legacy')); await until(() => calls.length === 1);
  assert.equal(calls[0]!.thread, 'legacy-thread'); assert.equal(calls[0]!.workspace, config.workspace);
  await bridge.receive(event('/new')); await bridge.receive(event('new isolated')); await until(() => calls.length === 2);
  assert.notEqual(calls[1]!.workspace, config.workspace); assert.equal(calls[0]!.signal.aborted, false);
  calls.forEach(item => item.release());
});

test('多个旧会话共享原目录时互斥，但不阻塞其他独立任务', async t => {
  const { calls, runner } = blockedRunner(); const { bridge, state, config } = await setup(t, runner);
  config.allowed.add('ou_other');
  for (const user of ['ou_owner', 'ou_other']) state.data.threads[JSON.stringify([config.workspace, 'chat', user])] = `legacy-${user}`;
  await bridge.receive(event('legacy A')); await until(() => calls.length === 1);
  await bridge.receive(event('legacy B', 'B', 'ou_other'));
  await bridge.receive(event('/task independent')); await until(() => calls.length === 2);
  assert.deepEqual(calls.map(item => item.prompt), ['legacy A', 'independent']);
  calls[0]!.release(); await until(() => calls.length === 3);
  assert.equal(calls[2]!.prompt, 'legacy B'); assert.equal(calls[2]!.workspace, config.workspace);
  calls[1]!.release(); calls[2]!.release();
});

test('旧状态在启动时迁移，即使先创建独立任务也能在列表中找到旧会话', async t => {
  const env = await setup(t, immediate); await env.bridge.shutdown();
  const key = JSON.stringify([env.config.workspace, 'chat', 'ou_owner']);
  env.state.data.threads[key] = 'old-thread'; await env.state.save();
  const restored = new State(env.state.path); await restored.load();
  const bridge = new Bridge(env.config, restored, immediate, env.reply, env.startTask, env.workspaces, async () => 'quoted text');
  await bridge.start();
  assert.ok(Object.values(restored.data.tasks).some(task => task.threadId === 'old-thread' && task.workspace === env.config.workspace));
  await bridge.receive(event('/task new')); await until(() => env.finals.length === 1);
  await bridge.receive(event('/tasks')); assert.ok(env.replies.at(-1)!.text.includes('已有会话'));
  await bridge.shutdown();
});

test('失败和超时写回卡片，并释放并行名额', async t => {
  for (const mode of ['failed', 'timeout']) await t.test(mode, async t => {
    const { bridge, state, config, finals } = await setup(t, { run: async (_, __, { signal }) => {
      if (mode === 'failed') throw new Error('failed');
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })); return '';
    } });
    config.timeout = mode === 'timeout' ? 20 : 5000;
    await bridge.receive(event('/task work')); await until(() => finals.length === 1);
    assert.equal(Object.values(state.data.tasks)[0]!.phase, mode);
    assert.ok(finals[0]!.includes(mode === 'failed' ? '任务失败' : '任务超时'));
  });
});

test('重启保留目录、线程和结果，运行任务中断后不自动重复，排队任务恢复', async t => {
  const env = await setup(t, immediate);
  await env.bridge.receive(event('/task first')); await until(() => env.finals.length === 1);
  await env.bridge.shutdown();
  const original = Object.values(env.state.data.tasks)[0]!;
  original.phase = 'running';
  const queued = { ...original, id: 't12345678', title: 'queued', prompt: 'queued', phase: 'queued' as const, messageId: 'queued-message', messageIds: ['queued-message'], cardId: 'queued-card' };
  delete queued.workspace; delete queued.threadId;
  env.state.data.tasks[queued.id] = queued; await env.state.save();
  const restored = new State(env.state.path); await restored.load();
  const prompts: string[] = [];
  const bridge = new Bridge(env.config, restored, { run: async prompt => { prompts.push(prompt); return 'queued result'; } }, env.reply, env.startTask, env.workspaces, async () => 'quoted text');
  await bridge.start(); await until(() => restored.data.tasks[queued.id]!.phase === 'completed');
  assert.deepEqual(prompts, ['queued']);
  assert.equal(restored.data.tasks[original.id]!.phase, 'interrupted');
  assert.equal(restored.data.tasks[original.id]!.workspace, original.workspace);
  assert.equal(restored.data.tasks[original.id]!.threadId, original.threadId);
  assert.equal(restored.data.tasks[queued.id]!.lastResult, 'queued result');
  await bridge.shutdown();
});

test('初始卡片失败时不执行任务；进度与结果带任务 ID', async t => {
  let calls = 0;
  const failed = await setup(t, { run: async () => { calls++; return ''; } }, async () => { throw new Error('failed'); });
  await failed.bridge.receive(event('work'));
  assert.equal(calls, 0); assert.equal(Object.values(failed.state.data.tasks)[0]!.phase, 'failed');
  const env = await setup(t, immediate);
  await env.bridge.receive(event('/task work')); await until(() => env.finals.length === 1);
  const task = Object.values(env.state.data.tasks)[0]!;
  assert.ok(env.updates.some(text => text.includes('测试通过')));
  assert.ok(env.finals[0]!.includes(task.id));
  await env.bridge.receive(event(`/result ${task.id}`)); assert.ok(env.replies.at(-1)!.text.includes('**任务完成**'));
});

test('Secret 校验、凭据环境隔离与中文分段', () => {
  assert.deepEqual(parseSecret('{"simple-codex-app-id":"id","simple-codex-app-secret":"secret"}'), { appId: 'id', appSecret: 'secret' });
  assert.throws(() => parseSecret('{}'));
  assert.deepEqual(codexEnvironment({ HOME: '/home/test', AWS_SECRET_ACCESS_KEY: 'secret', OPENAI_API_KEY: 'secret' }), { HOME: '/home/test' });
  const text = '你好🙂'.repeat(5000); assert.equal(chunks(text).join(''), text);
});

function groupEvent(text: string, chat = 'group-a', user = 'ou_owner', id = Math.random().toString()): MessageEvent {
  const message = event(text, id, user);
  message.message.chat_type = 'group'; message.message.chat_id = chat;
  return message;
}

test('四个群真正并行，同群授权用户共享上下文，后续消息依次执行', async t => {
  const { calls, runner } = blockedRunner();
  const { bridge, state, config } = await setup(t, runner);
  config.parallel = 4; config.allowed.add('ou_other');
  for (const chat of ['a', 'b', 'c', 'd']) await bridge.receive(groupEvent(`first-${chat}`, chat));
  await until(() => calls.length === 4);
  assert.equal(new Set(calls.map(call => call.workspace)).size, 4);
  await bridge.receive(groupEvent('second-a', 'a', 'ou_other'));
  await bridge.receive(groupEvent('third-a', 'a'));
  assert.equal(calls.length, 4);
  assert.equal(Object.values(state.data.tasks).filter(task => task.phase === 'queued').length, 2);
  calls[0]!.release(); await until(() => calls.length === 5);
  assert.equal(calls[4]!.prompt, 'second-a');
  assert.equal(calls[4]!.thread, 'thread-0');
  assert.equal(calls[4]!.workspace, calls[0]!.workspace);
  calls[4]!.release(); await until(() => calls.length === 6);
  assert.equal(calls[5]!.prompt, 'third-a'); assert.equal(calls[5]!.thread, 'thread-0');
  assert.equal(calls[5]!.workspace, calls[0]!.workspace);
  for (const call of calls) call.release();
});

test('群聊提及、命令、跨群权限与取消排队后的上下文衔接', async t => {
  const { calls, runner } = blockedRunner();
  const { bridge, state, replies, config } = await setup(t, runner);
  config.allowed.add('ou_other');
  const who = groupEvent('@_user_1 /whoami'); who.message.mentions = [{ key: '@_user_1' }];
  await bridge.receive(who); assert.match(replies.at(-1)!.text, /ou_owner/);
  await bridge.receive(groupEvent('forbidden', 'a', 'ou_stranger'));
  assert.equal(Object.keys(state.data.tasks).length, 0);
  const first = groupEvent('@_user_1 first', 'a'); first.message.mentions = [{ key: '@_user_1' }];
  await bridge.receive(first); await until(() => calls.length === 1);
  await bridge.receive(groupEvent('cancel this', 'a'));
  await bridge.receive(groupEvent('after cancelled', 'a'));
  const tasks = Object.values(state.data.tasks);
  await bridge.receive(groupEvent(`/result ${tasks[0]!.id}`, 'b'));
  assert.match(replies.at(-1)!.text, /找不到/);
  await bridge.receive(groupEvent(`/tasks`, 'a', 'ou_other'));
  assert.ok(replies.at(-1)!.text.includes(tasks[0]!.id));
  await bridge.receive(groupEvent(`/cancel ${tasks[1]!.id}`, 'a', 'ou_other'));
  calls[0]!.release(); await until(() => calls.length === 2);
  assert.equal(calls[1]!.prompt, 'after cancelled');
  assert.equal(calls[1]!.thread, 'thread-0'); assert.equal(calls[1]!.workspace, calls[0]!.workspace);
  calls[1]!.release();
});

test('群会话重启保留上下文，回复旧卡片仍衔接最新一轮；new 显式重开', async t => {
  const inputs: { prompt: string; thread?: string; workspace?: string }[] = [];
  const runner: Runner = { run: async (prompt, thread, hooks) => {
    inputs.push({ prompt, thread, workspace: hooks.workingDirectory });
    await hooks.onThread(`thread-${inputs.length}`); return 'done';
  } };
  const env = await setup(t, runner);
  await env.bridge.receive(groupEvent('first', 'a', 'ou_owner', 'first'));
  await until(() => env.finals.length === 1); await env.bridge.shutdown();
  const restored = new State(env.state.path); await restored.load();
  const bridge = new Bridge(env.config, restored, runner, env.reply, env.startTask, env.workspaces, async () => 'quoted text');
  t.after(() => bridge.shutdown()); await bridge.start();
  await bridge.receive(groupEvent('second', 'a')); await until(() => env.finals.length === 2);
  const third = groupEvent('third', 'a'); third.message.parent_id = 'card-first';
  await bridge.receive(third); await until(() => env.finals.length === 3);
  assert.equal(inputs[1]!.thread, 'thread-1'); assert.equal(inputs[2]!.thread, 'thread-2');
  assert.equal(inputs[2]!.workspace, inputs[0]!.workspace);
  await bridge.receive(groupEvent('/new', 'a')); await bridge.receive(groupEvent('fresh', 'a'));
  await until(() => env.finals.length === 4);
  assert.equal(inputs[3]!.thread, undefined); assert.notEqual(inputs[3]!.workspace, inputs[0]!.workspace);
});

test('群前一条消息创建卡片失败后，已就绪的后续任务能继续调度', async t => {
  let rejectFirst!: (error: Error) => void;
  let creating = false;
  const prompts: string[] = [];
  const factory: TaskCardFactory = async id => {
    if (id === 'broken-card') {
      creating = true;
      await new Promise((_, reject) => { rejectFirst = reject; });
    }
    return { messageId: `card-${id}`, update: () => {}, finish: async () => {} };
  };
  const env = await setup(t, { run: async prompt => { prompts.push(prompt); return 'done'; } }, factory);
  const first = env.bridge.receive(groupEvent('first', 'a', 'ou_owner', 'broken-card'));
  await until(() => creating);
  await env.bridge.receive(groupEvent('second', 'a'));
  assert.deepEqual(prompts, []);
  rejectFirst(new Error('card failed')); await first;
  await until(() => prompts.length === 1); assert.deepEqual(prompts, ['second']);
});

test('引用后仅 @机器人也读取直接父消息并回复，附加要求与原文一起送入 Codex', async t => {
  const inputs: string[] = []; const reads: string[] = [];
  const env = await setup(t, { run: async prompt => { inputs.push(prompt); return '回答'; } }, undefined,
    async (id, chat) => { reads.push(`${chat}/${id}`); return '怎么接入 Lark MCP？'; });
  const first = groupEvent('@_user_1', 'a');
  first.message.mentions = [{ key: '@_user_1' }]; first.message.parent_id = 'direct'; first.message.root_id = 'root';
  await env.bridge.receive(first); await until(() => env.finals.length === 1);
  assert.deepEqual(reads, ['a/direct']);
  assert.match(inputs[0]!, /请读取并回复/); assert.match(inputs[0]!, /怎么接入 Lark MCP/);
  const next = groupEvent('请详细解释', 'a'); next.message.parent_id = 'direct';
  await env.bridge.receive(next); await until(() => env.finals.length === 2);
  assert.match(inputs[1]!, /请详细解释/); assert.match(inputs[1]!, /怎么接入 Lark MCP/);
});

test('未授权、重复消息及纯命令不触发引用读取；引用失败不调用 Codex', async t => {
  let reads = 0; let runs = 0;
  const env = await setup(t, { run: async () => { runs++; return ''; } }, undefined, async () => { reads++; throw new Error('forbidden'); });
  const denied = groupEvent('@_user_1', 'a', 'ou_stranger');
  denied.message.mentions = [{ key: '@_user_1' }]; denied.message.parent_id = 'source';
  await env.bridge.receive(denied); assert.equal(reads, 0);
  const command = groupEvent('/tasks'); command.message.parent_id = 'source';
  await env.bridge.receive(command); assert.equal(reads, 0);
  const request = groupEvent('解释一下'); request.message.parent_id = 'source';
  await Promise.all([env.bridge.receive(request), env.bridge.receive(request)]);
  await until(() => env.finals.length === 1);
  assert.equal(reads, 1); assert.equal(runs, 0); assert.match(env.finals[0]!, /无法读取被引用/);
});

test('后续普通续聊不重复读取上一轮引用，排队引用信息会持久化', async t => {
  let reads = 0;
  const env = await setup(t, immediate, undefined, async () => { reads++; return '原文'; });
  const first = groupEvent('回答'); first.message.parent_id = 'source';
  await env.bridge.receive(first); await until(() => env.finals.length === 1);
  const saved = new State(env.state.path); await saved.load();
  assert.equal(Object.values(saved.data.tasks)[0]!.reference?.messageId, 'source');
  await env.bridge.receive(groupEvent('继续')); await until(() => env.finals.length === 2);
  assert.equal(reads, 1);
});
