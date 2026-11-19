import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadEvent } from '@openai/codex-sdk';
import { consumeEvents, progressForEvent } from '../src/runner.ts';
import { renderProgress, renderFinal, type TaskProgress } from '../src/progress.ts';

async function* stream(events: ThreadEvent[]) { yield* events; }

test('SDK 事件输出任务计划、命令与阶段性回复，不暴露 reasoning 项', async () => {
  const progress: TaskProgress[] = [];
  const threads: string[] = [];
  const events: ThreadEvent[] = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.updated', item: { id: 'plan', type: 'todo_list', items: [{ text: '运行测试', completed: false }] } },
    { type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } },
    { type: 'item.updated', item: { id: 'cmd', type: 'command_execution', command: 'npm test', aggregated_output: '测试通过', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: '不可展示的推理' } },
    { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: '**修复完成**' } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ];
  const result = await consumeEvents(stream(events), { signal: new AbortController().signal, onThread: async id => { threads.push(id); }, onProgress: item => { progress.push(item); } });
  assert.equal(result, '**修复完成**');
  assert.deepEqual(threads, ['thread-1']);
  assert.ok(progress.some(item => item.output?.includes('测试通过')));
  assert.deepEqual(progress.at(-1)?.plan, [{ text: '运行测试', completed: false }]);
  assert.ok(!JSON.stringify(progress).includes('不可展示的推理'));
});

test('没有完成事件和明确失败都不能被当成成功', async () => {
  const hooks = { signal: new AbortController().signal, onThread: async () => {} };
  await assert.rejects(consumeEvents(stream([]), hooks), /without completion/);
  await assert.rejects(consumeEvents(stream([{ type: 'turn.failed', error: { message: 'error' } }]), hooks), /turn failed/);
  assert.equal(progressForEvent({ type: 'item.updated', item: { id: 'r', type: 'reasoning', text: 'private' } }), undefined);
});

test('进度展示耗时、完成标记、近期输出并限制输出量', () => {
  const text = renderProgress({ step: '正在测试', plan: [{ text: '检查项目', completed: true }, { text: '运行测试', completed: false }], output: 'x'.repeat(20000) + '\n日志```', outputKind: 'text' }, 65000);
  assert.match(text, /1 分 5 秒/);
  assert.match(text, /\[x\] 检查项目/);
  assert.match(text, /\[ \] 运行测试/);
  assert.match(text, /````/);
  assert.ok(text.length < 5000);
  for (const status of ['completed', 'failed', 'cancelled', 'timeout'] as const) {
    assert.match(renderFinal(status, '结果', 1000), /结果/);
    assert.ok(!renderFinal(status, '结果', 1000).includes('正在执行'));
  }
});
