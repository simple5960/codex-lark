export type ReferenceReader = (messageId: string, chatId: string) => Promise<string>;
type SourceMessage = {
  message_id?: string; chat_id?: string; msg_type?: string; deleted?: boolean;
  body?: { content?: string };
};
type GetMessage = (messageId: string) => Promise<{ code?: number; data?: { items?: SourceMessage[] } }>;

// 只提取可读正文，不把附件 key、回调数据等整个 JSON 当成用户消息。
export function referenceText(type: string, content: string): string {
  const body: unknown = JSON.parse(content);
  const lines: string[] = [];
  let visited = 0;
  let length = 0;
  const append = (text: string) => {
    if (length >= 12_000) return;
    const part = Array.from(text).slice(0, 12_000 - length).join('');
    lines.push(part); length += Array.from(part).length;
  };
  const walk = (value: unknown, depth = 0): void => {
    if (++visited > 2000 || depth > 20 || length >= 12_000) return;
    if (typeof value === 'string') { append(value); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    for (const key of ['title', 'text', 'content', 'elements', 'body', 'fields', 'columns', 'property']) {
      if (node[key] !== undefined) walk(node[key], depth + 1);
    }
  };
  if (!['text', 'post', 'interactive'].includes(type)) throw new Error('UnsupportedReference');
  if (type === 'post' && body && typeof body === 'object' && !('content' in body)) {
    // 多语言富文本只选一个版本，避免同一正文重复送入上下文。
    const variants = body as Record<string, unknown>;
    walk(variants.zh_cn ?? variants.en_us ?? Object.values(variants)[0]);
  } else if (type === 'interactive' && body && typeof body === 'object' && 'json_card' in body && typeof body.json_card === 'string') {
    // Lark raw_card_content 将原始卡片 JSON 再包装成字符串。
    walk(JSON.parse(body.json_card));
  } else walk(body);
  const text = lines.join('\n').trim();
  if (!text) throw new Error('EmptyReference');
  return text + (length >= 12_000 ? '\n[引用内容过长，已截断]' : '');
}

export function createReferenceReader(get: GetMessage): ReferenceReader {
  return async (messageId, chatId) => {
    const response = await get(messageId);
    const message = response.data?.items?.find(item => item.message_id === messageId);
    if (response.code !== 0 || !message || message.deleted || message.chat_id !== chatId || !message.body?.content) {
      throw new Error('ReferenceUnavailable');
    }
    return referenceText(message.msg_type || '', message.body.content);
  };
}
