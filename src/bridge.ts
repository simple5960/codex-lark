import type { Config } from './config.ts';
import type { Runner } from './runner.ts';
import type { State } from './state.ts';
import { renderProgress, renderFinal, type TaskProgress, type TaskCard, type TaskCardFactory } from './progress.ts';

export type MessageEvent = {
  sender: { sender_type?: string; sender_id?: { open_id?: string } };
  message: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string };
};
export type Reply = (messageId: string, text: string) => Promise<void>;
const help = '直接发送文字即可让 Codex 工作。\n/help 帮助\n/whoami 查看你的 open_id\n/status 查看任务状态\n/new 开始新会话\n/cancel 取消当前任务\n/login 查看 ChatGPT 登录说明';

export class Bridge {
  private active: { key: string; controller: AbortController; done: Promise<void> } | undefined;
  private closing = false;
  private config: Config;
  private state: State;
  private runner: Runner;
  private reply: Reply;
  private startTask: TaskCardFactory | undefined;
  constructor(config: Config, state: State, runner: Runner, reply: Reply, startTask?: TaskCardFactory) {
    this.config = config; this.state = state; this.runner = runner; this.reply = reply;
    this.startTask = startTask;
  }

  async receive(event: MessageEvent) {
    const { message, sender } = event;
    // 只接收真人私聊，避免群聊中的意外触发。
    if (this.closing || sender.sender_type !== 'user' || message.chat_type !== 'p2p' || message.message_type !== 'text') return;
    const user = sender.sender_id?.open_id;
    if (!user) return;
    let prompt: string;
    try {
      const body = JSON.parse(message.content) as { text?: unknown };
      if (typeof body.text !== 'string') return;
      prompt = body.text.trim();
    } catch { return; }
    if (!prompt || !(await this.state.claim(message.message_id))) return;
    const send = (text: string) => this.reply(message.message_id, text);
    if (prompt === '/whoami') { await send(`你的 open_id：${user}\n请将它加入本机 ALLOWED_OPEN_IDS 并重启服务。`); return; }
    if (!this.config.allowed.has(user)) { await send('此账号尚未授权。发送 /whoami 获取 ID，由服务管理员加入白名单。'); return; }
    const key = JSON.stringify([this.config.workspace, message.chat_id, user]);
    if (prompt === '/help') { await send(help); return; }
    if (prompt === '/login') { await send('请在运行机器的终端执行 npm run login，使用 ChatGPT 完成浏览器登录；无浏览器时执行 npm run login:device。登录凭据只保存在运行机器，聊天中无需提供密码或 token。'); return; }
    if (prompt === '/status') {
      await send(this.active?.key === key ? 'Codex 正在执行你的任务。' : `当前会话空闲。${this.active ? '其他会话正在占用工作目录。' : ''}\n工作目录：${this.config.workspace}\n沙箱：${this.config.sandbox}`);
      return;
    }
    if (prompt === '/cancel') {
      if (this.active?.key !== key) { await send('当前会话没有正在执行的任务。'); return; }
      this.active.controller.abort();
      await send('已请求取消；正在结束 Codex 进程。已产生的文件修改会保留。');
      return;
    }
    if (prompt === '/new') {
      if (this.active?.key === key) { await send('请先 /cancel，等待任务结束后再 /new。'); return; }
      delete this.state.data.threads[key];
      await this.state.save();
      await send('已开始新会话。下一条消息将创建新的 Codex 线程。');
      return;
    }
    if (prompt.startsWith('/')) { await send(help); return; }
    if (this.active) { await send('工作目录正在执行任务，请完成后重试。可用 /status 查看，或用 /cancel 取消自己的任务。'); return; }
    const controller = new AbortController();
    // 先占用工作目录，再异步发送确认消息。
    const active = { key, controller, done: Promise.resolve() };
    this.active = active;
    active.done = this.execute(key, message.message_id, prompt, controller, send);
    // Lark handler 立即返回 ACK；长任务在后台运行，避免消息重试。
    void active.done.finally(() => { if (this.active === active) this.active = undefined; }).catch(() => {});
  }

  private async execute(key: string, messageId: string, prompt: string, controller: AbortController, send: (text: string) => Promise<void>) {
    let timedOut = false;
    const started = Date.now();
    let card: TaskCard | undefined;
    let progress: TaskProgress = { step: '正在启动 Codex' };
    const elapsed = () => Date.now() - started;
    const finish = (status: Parameters<typeof renderFinal>[0], text: string) => card ? card.finish(renderFinal(status, text, elapsed())) : send(text);
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeout);
    const heartbeat = setInterval(() => {
      if (card) card.update(renderProgress(progress, elapsed()));
      else if (!this.startTask) void send('Codex 仍在执行，可发送 /cancel 取消。').catch(() => console.error('进度消息发送失败'));
    }, 60_000);
    try {
      if (this.startTask) card = await this.startTask(messageId, renderProgress(progress, elapsed()));
      else await send('已收到，Codex 开始执行。');
      const result = await this.runner.run(prompt, this.state.data.threads[key], {
        signal: controller.signal,
        onThread: async id => { this.state.data.threads[key] = id; await this.state.save(); },
        onProgress: update => {
          progress = update;
          card?.update(renderProgress(progress, elapsed()));
        },
      });
      await finish('completed', result);
    } catch {
      const text = timedOut ? '任务已超时并停止。已产生的文件修改会保留。' : controller.signal.aborted ? '任务已取消。已产生的文件修改会保留。' : '任务执行或结果发送失败。请检查本机 ChatGPT 登录、模型权限及网络连接；可用 /new 重开会话后重试。';
      await finish(timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'failed', text).catch(() => console.error('任务通知发送失败'));
      console.error(timedOut ? '任务超时' : controller.signal.aborted ? '任务取消' : '任务失败（未记录提示词或原始异常）');
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
  }
  async shutdown() {
    this.closing = true;
    this.active?.controller.abort();
    await this.active?.done;
  }
}

export function chunks(text: string, maxBytes = 12_000): string[] {
  const result: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of text) {
    const length = Buffer.byteLength(char);
    if (bytes + length > maxBytes) { result.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += length;
  }
  if (chunk) result.push(chunk);
  return result;
}
