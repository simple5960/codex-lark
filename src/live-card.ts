import { markdownCard, markdownParts } from './messages.ts';
import type { Reply } from './bridge.ts';
import type { TaskCard, TaskCardFactory } from './progress.ts';

type Result = { code?: number; data?: { message_id?: string } };
type CreateCard = (messageId: string, content: string) => Promise<Result>;
type PatchCard = (messageId: string, content: string) => Promise<{ code?: number }>;
const content = (markdown: string) => JSON.stringify(markdownCard(markdown));

class LiveCard implements TaskCard {
  get messageId() { return this.cardId; }
  private pending: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy: Promise<void> | undefined;
  private lastWrite = Date.now();
  private closed = false;
  private finalization: Promise<void> | undefined;
  private originId: string;
  private cardId: string;
  private patch: PatchCard;
  private reply: Reply;
  private interval: number;

  constructor(originId: string, cardId: string, patch: PatchCard, reply: Reply, interval: number) {
    this.originId = originId; this.cardId = cardId; this.patch = patch; this.reply = reply; this.interval = interval;
  }

  update(markdown: string) {
    if (this.closed) return;
    if (Buffer.byteLength(content(markdown)) > 28_000) markdown = markdownParts(markdown)[0] || 'Codex 正在执行';
    this.pending = markdown;
    this.schedule();
  }
  private schedule() {
    if (this.closed || this.timer || this.busy || !this.pending) return;
    const delay = Math.max(0, this.interval - (Date.now() - this.lastWrite));
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }
  private async write(markdown: string) {
    this.lastWrite = Date.now();
    const response = await this.patch(this.cardId, content(markdown));
    if (response.code !== 0) throw new Error('Lark 卡片更新失败');
  }
  private async flush() {
    if (this.closed || this.busy || !this.pending) return;
    const markdown = this.pending;
    this.pending = undefined;
    this.busy = this.write(markdown).catch(() => {
      console.warn('进度卡片更新失败，将在下次进度更新时重试');
    }).finally(() => { this.busy = undefined; this.schedule(); });
    await this.busy;
  }

  finish(markdown: string) {
    this.finalization ??= this.close(markdown);
    return this.finalization;
  }
  private async close(markdown: string) {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending = undefined;
    // 等待旧请求完成，确保过期的进度不会覆盖最终结果。
    await this.busy;
    const parts = Buffer.byteLength(content(markdown)) <= 28_000 ? [markdown] : markdownParts(markdown);
    const first = parts[0] || '任务已结束。';
    try {
      await this.write(first + (parts.length > 1 ? '\n\n> 结果较长，其余部分见下方补充卡片。' : ''));
    } catch {
      // 更新接口暂不可用时，仍交付完整的最终结果。
      await this.reply(this.originId, markdown);
      return;
    }
    for (const part of parts.slice(1)) await this.reply(this.originId, part);
  }
}

export function createTaskCardFactory(create: CreateCard, patch: PatchCard, reply: Reply, intervalMs = 2000): TaskCardFactory {
  return async (messageId, markdown, existingMessageId) => {
    if (existingMessageId) {
      const card = new LiveCard(messageId, existingMessageId, patch, reply, intervalMs);
      card.update(markdown);
      return card;
    }
    const result = await create(messageId, content(markdown));
    const cardId = result.data?.message_id;
    if (result.code !== 0 || !cardId) throw new Error('无法创建任务进度卡片');
    return new LiveCard(messageId, cardId, patch, reply, intervalMs);
  };
}
