import { randomUUID } from 'node:crypto';
import { chunks, type Reply } from './bridge.ts';

// 留出 JSON 转义、卡片结构及跨段代码围栏的空间。
export function markdownParts(text: string, maxBytes = 4_000): string[] {
  const parts: string[] = [];
  let body = '';
  let fence: { marker: string; opening: string } | undefined;
  const flush = () => {
    if (!body) return;
    parts.push(body + (fence ? `\n${fence.marker}` : ''));
    body = fence ? `${fence.opening}\n` : '';
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    for (const piece of chunks(line, maxBytes)) {
      if (body && Buffer.byteLength(body + piece) > maxBytes) flush();
      body += piece;
    }
    const marker = line.trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = { marker: run, opening: line.trimEnd() };
      else if (run[0] === fence.marker[0] && run.length >= fence.marker.length && !marker[2]!.trim()) fence = undefined;
    }
  }
  if (body) parts.push(body + (fence ? `\n${fence.marker}` : ''));
  return parts;
}

export function markdownCard(markdown: string) {
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  };
}

type MessageData = { msg_type: string; content: string; uuid: string };
type SendMessage = (messageId: string, data: MessageData) => Promise<{ code?: number }>;

export function createMarkdownReply(send: SendMessage): Reply {
  return async (messageId, text) => {
    for (const part of markdownParts(text)) {
      let response: { code?: number };
      try {
        response = await send(messageId, {
          msg_type: 'interactive', content: JSON.stringify(markdownCard(part)), uuid: randomUUID(),
        });
      } catch (error) {
        // SDK 对 HTTP 400 的卡片格式错误会抛出异常，但 API 已明确拒绝接收。
        const failure = error as { response?: { status?: number; data?: { code?: number } } } | null;
        const code = failure?.response?.data?.code;
        if (failure?.response?.status !== 400 || typeof code !== 'number' || code === 0) throw error;
        response = { code };
      }
      // 仅在 API 明确拒绝卡片时退回文本；网络异常不重发，避免重复消息。
      if (response.code !== 0) {
        console.warn('Lark 卡片被拒绝，回退纯文本');
        const fallback = await send(messageId, {
          msg_type: 'text', content: JSON.stringify({ text: part }), uuid: randomUUID(),
        });
        if (fallback.code !== 0) throw new Error('Lark 回复失败');
      }
    }
  };
}
