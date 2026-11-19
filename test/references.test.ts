import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceText, createReferenceReader } from '../src/references.ts';

test('提取引用的文本、富文本及卡片正文，忽略附件和交互回调字段', () => {
  assert.equal(referenceText('text', JSON.stringify({ text: '怎么接入 MCP？' })), '怎么接入 MCP？');
  const post = { zh_cn: { title: '标题', content: [[{ tag: 'text', text: '内容' }, { tag: 'a', text: '文档', href: 'https://example.com' }]] }, en_us: { title: 'duplicate' } };
  assert.equal(referenceText('post', JSON.stringify(post)), '标题\n内容\n文档');
  const card = { body: { elements: [{ tag: 'markdown', content: '**结果**' }, { tag: 'button', text: { tag: 'plain_text', content: '继续' }, value: { secret: 'hidden' } }] } };
  assert.equal(referenceText('interactive', JSON.stringify(card)), '**结果**\n继续');
  assert.equal(referenceText('interactive', JSON.stringify({ json_card: JSON.stringify(card), json_attachment: { images: { secret: 'hidden' } } })), '**结果**\n继续');
  assert.throws(() => referenceText('image', '{"image_key":"secret"}'));
  assert.throws(() => referenceText('text', 'bad json'));
  assert.throws(() => referenceText('interactive', '{"body":{}}'));
});

test('引用长度有上限，Unicode 不损坏', () => {
  const text = referenceText('text', JSON.stringify({ text: '🙂'.repeat(15000) }));
  assert.ok(text.endsWith('[引用内容过长，已截断]')); assert.ok(!text.includes('\uFFFD'));
  assert.equal(Array.from(text.split('\n')[0]!).length, 12000);
});

test('只读取同一聊天的指定消息；撤回、跨群、API 失败及缺失消息均拒绝', async () => {
  const message = { message_id: 'source', chat_id: 'chat', msg_type: 'text', body: { content: '{"text":"原文"}' } };
  const reader = createReferenceReader(async () => ({ code: 0, data: { items: [message] } }));
  assert.equal(await reader('source', 'chat'), '原文');
  await assert.rejects(reader('source', 'other-chat'));
  await assert.rejects(reader('other-message', 'chat'));
  await assert.rejects(createReferenceReader(async () => ({ code: 0, data: { items: [{ ...message, deleted: true }] } }))('source', 'chat'));
  await assert.rejects(createReferenceReader(async () => ({ code: 999 }))('source', 'chat'));
});
