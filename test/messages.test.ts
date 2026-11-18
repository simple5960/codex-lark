import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownReply, markdownParts } from '../src/messages.ts';

test('短消息完整保留 Markdown，使用 JSON 2.0 卡片回复原消息', async () => {
  const markdown = '# 任务完成\n\n- **已修复**\n- [文档](https://example.com)\n\n```ts\nconsole.log("你好🙂");\n```';
  let calls = 0;
  const reply = createMarkdownReply(async (id, data) => {
    calls++;
    assert.equal(id, 'om_original');
    assert.equal(data.msg_type, 'interactive');
    assert.ok(data.uuid);
    const card = JSON.parse(data.content);
    assert.equal(card.schema, '2.0');
    assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: markdown }]);
    return { code: 0 };
  });
  await reply('om_original', markdown);
  assert.equal(calls, 1);
});

test('长消息保留 Unicode，每张卡片含 JSON 转义后的大小留在限制内', async () => {
  const source = '中文🙂"\\\u0000'.repeat(4000);
  const parts = markdownParts(source);
  assert.equal(parts.join(''), source);
  assert.ok(parts.length > 1);
  const ids = new Set<string>();
  await createMarkdownReply(async (_, data) => {
    assert.ok(Buffer.byteLength(data.content) < 28000);
    assert.ok(!ids.has(data.uuid)); ids.add(data.uuid);
    return { code: 0 };
  })('om_original', source);
  assert.equal(ids.size, parts.length);
});

test('代码块跨消息自动闭合并重新打开，保留语言标记和全部代码', () => {
  for (const marker of ['```', '~~~~']) {
    const lines = Array.from({ length: 100 }, (_, i) => `console.log("${i}：你好🙂");\n`);
    const source = `${marker}ts\n${lines.join('')}${marker}`;
    const parts = markdownParts(source, 200);
    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.ok(part.startsWith(`${marker}ts\n`));
      assert.ok(part.endsWith(marker));
    }
    for (const line of lines) assert.equal(parts.filter(part => part.includes(line)).length, 1);
  }
});

test('单行超长代码和未闭合的代码块也能安全切分', () => {
  const source = '```js\n' + 'x'.repeat(15000);
  const parts = markdownParts(source);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => part.slice('```js\n'.length, -'\n```'.length)).join(''), 'x'.repeat(15000));
});

test('卡片明确被拒绝后回退文本，原样保留内容', async () => {
  const types: string[] = [];
  await createMarkdownReply(async (_, data) => {
    types.push(data.msg_type);
    if (data.msg_type === 'interactive') return { code: 230099 };
    assert.equal(JSON.parse(data.content).text, '**原内容**');
    return { code: 0 };
  })('om_original', '**原内容**');
  assert.deepEqual(types, ['interactive', 'text']);
});

test('网络异常不重发；卡片与文本均失败时报告失败', async () => {
  let calls = 0;
  await assert.rejects(createMarkdownReply(async () => { calls++; throw new Error('network'); })('om_original', 'test'));
  assert.equal(calls, 1);
  await assert.rejects(createMarkdownReply(async () => ({ code: 230001 }))('om_original', 'test'), /Lark 回复失败/);
});

test('SDK 抛出带明确 API 错误码的 HTTP 400 时也可回退', async () => {
  const types: string[] = [];
  await createMarkdownReply(async (_, data) => {
    types.push(data.msg_type);
    if (data.msg_type === 'interactive') throw { response: { status: 400, data: { code: 230099 } } };
    return { code: 0 };
  })('om_original', 'test');
  assert.deepEqual(types, ['interactive', 'text']);
});
