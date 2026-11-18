import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import type { Runner } from './runner.ts';
import type { State } from './state.ts';
import { renderProgress, renderFinal, type TaskProgress, type TaskCard, type TaskCardFactory } from './progress.ts';
import { GitWorkspaces, type TaskWorkspaces } from './workspaces.ts';
import { phaseLabels, type TaskRecord } from './tasks.ts';

export type MessageEvent = {
  sender: { sender_type?: string; sender_id?: { open_id?: string } };
  message: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string; parent_id?: string; root_id?: string; mentions?: { key: string }[] };
};
export type Reply = (messageId: string, text: string) => Promise<void>;
type ActiveTask = { controller: AbortController; done: Promise<void>; progress: TaskProgress };
const help = [
  '群聊：一个群共用上下文，同群消息依次执行，不同群并行。无需 /session。',
  '私聊：空闲时续聊，忙碌时创建独立任务。回复卡片可定位任务。',
  '/task 描述：创建独立任务', '/tasks：查看自己的任务', '/status [任务ID]：任务状态',
  '/continue 任务ID 描述：继续指定任务', '/result 任务ID：查看最近结果',
  '/cancel [任务ID]：取消任务，多任务时请指定 ID', '/new [描述]：切换到新会话',
  '/whoami：查看身份', '/login：ChatGPT 登录说明',
].join('\n');
const inline = (text: string) => text.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/\s+/g, ' ');

export class Bridge {
  private active = new Map<string, ActiveTask>();
  private ready = new Set<string>();
  private cards = new Map<string, Promise<TaskCard | undefined>>();
  private closing = false;
  private startup: Promise<void> | undefined;
  private config: Config;
  private state: State;
  private runner: Runner;
  private reply: Reply;
  private startTask: TaskCardFactory | undefined;
  private workspaces: TaskWorkspaces;

  constructor(config: Config, state: State, runner: Runner, reply: Reply, startTask?: TaskCardFactory, workspaces?: TaskWorkspaces) {
    this.config = config; this.state = state; this.runner = runner; this.reply = reply;
    this.startTask = startTask;
    this.workspaces = workspaces ?? new GitWorkspaces(config.workspace, config.worktreeRoot);
  }

  start() { this.startup ??= this.restore(); return this.startup; }

  private async restore() {
    for (const key of Object.keys(this.state.data.threads)) {
      try {
        const scope: unknown = JSON.parse(key);
        if (Array.isArray(scope) && scope.length === 3 && scope[0] === this.config.workspace) this.current(key);
      } catch { /* 保留其他旧状态，但不为无效会话创建任务。 */ }
    }
    for (const task of Object.values(this.state.data.tasks)) {
      if (task.phase === 'running') {
        task.phase = 'interrupted'; task.updatedAt = Date.now();
        task.lastResult = `服务重启，任务已中断，已有文件修改保留。用 /continue ${task.id} 描述 继续。`;
        await this.finishCard(task).catch(() => console.warn(`任务 ${task.id} 中断通知失败`));
      } else if (task.phase === 'queued') {
        try { await this.ensureCard(task); this.ready.add(task.id); }
        catch { task.phase = 'failed'; task.lastResult = '恢复任务卡片失败，未自动执行。请用 /continue 重试。'; }
      }
    }
    await this.state.save();
    this.pump();
  }

  private newId() {
    let id: string;
    do { id = `t${randomBytes(4).toString('hex')}`; } while (this.state.data.tasks[id]);
    return id;
  }
  private owned(key: string) { return Object.values(this.state.data.tasks).filter(task => task.ownerKey === key); }
  private find(key: string, id: string) {
    const task = this.state.data.tasks[id];
    return task?.ownerKey === key ? task : undefined;
  }
  private busy(task: TaskRecord) { return task.phase === 'queued' || task.phase === 'running' || this.active.has(task.id); }
  private describe(task: TaskRecord) {
    return `\`${task.id}\` · ${phaseLabels[task.phase]} · ${inline(task.title)}`;
  }
  private context(task: TaskRecord, text: string) {
    const fields = [`**任务 ID：** \`${task.id}\``];
    if (task.branch) fields.push(`**分支：** \`${inline(task.branch)}\``);
    if (task.workspace) fields.push(`**工作目录：** \`${inline(task.workspace)}\``);
    return `${text.replace('/cancel 取消', `/cancel ${task.id} 取消`)}\n\n---\n${fields.join('\n\n')}`;
  }
  private progress(task: TaskRecord, update: TaskProgress, elapsed = 0) {
    return this.context(task, renderProgress(update, elapsed));
  }
  private ensureCard(task: TaskRecord) {
    let pending = this.cards.get(task.id);
    if (!pending) {
      pending = (async () => {
        if (!this.startTask) return undefined;
        const initial = task.phase === 'queued' ? this.context(task, '## ⏳ 任务已排队\n\n等待可用执行名额。') : this.progress(task, { step: '正在恢复任务状态' });
        const card = await this.startTask(task.messageId, initial, task.cardId);
        if (card.messageId) {
          task.cardId = card.messageId;
          if (!task.messageIds.includes(card.messageId)) task.messageIds.push(card.messageId);
          await this.state.save();
        }
        return card;
      })();
      this.cards.set(task.id, pending);
    }
    return pending;
  }
  private async finishCard(task: TaskRecord, elapsed = 0) {
    const phase = task.phase === 'queued' || task.phase === 'running' ? 'failed' : task.phase;
    const text = this.context(task, renderFinal(phase, task.lastResult || '任务已结束。', elapsed));
    const card = await this.ensureCard(task);
    if (card) await card.finish(text);
    else await this.reply(task.messageId, text);
  }

  private current(key: string): TaskRecord | undefined {
    const current = this.state.data.current[key];
    if (current) {
      const task = this.find(key, current);
      if (task) return task;
      delete this.state.data.current[key];
    }
    // 旧版本会话继续使用原目录和线程，保留部署前的未提交修改。
    const threadId = this.state.data.threads[key];
    if (!threadId) return;
    const now = Date.now();
    const task: TaskRecord = {
      id: this.newId(), ownerKey: key, title: '已有会话', prompt: '', phase: 'completed',
      createdAt: now, updatedAt: now, queuedAt: now, messageId: '', messageIds: [],
      workspace: this.config.workspace, threadId,
    };
    this.state.data.tasks[task.id] = task;
    this.state.data.current[key] = task.id;
    return task;
  }

  async receive(event: MessageEvent) {
    const { message, sender } = event;
    if (this.closing || sender.sender_type !== 'user' || !['p2p', 'group'].includes(message.chat_type) || message.message_type !== 'text') return;
    const user = sender.sender_id?.open_id;
    if (!user) return;
    let prompt: string;
    try {
      const body = JSON.parse(message.content) as { text?: unknown };
      if (typeof body.text !== 'string') return;
      prompt = body.text.trim();
      // Lark 用 mentions 中的 key 表示 @；只移除开头的实际提及，保留正文中的提及。
      for (;;) {
        const mention = message.mentions?.find(item => item.key && prompt.startsWith(item.key) && /^(?:\s|$)/.test(prompt.slice(item.key.length)));
        if (!mention) break;
        prompt = prompt.slice(mention.key.length).trimStart();
      }
    } catch { return; }
    if (!prompt || !(await this.state.claim(message.message_id))) return;
    const send = (text: string) => this.reply(message.message_id, text);
    if (prompt === '/whoami') { await send(`你的 open_id：${user}`); return; }
    if (!this.config.allowed.has(user)) { await send('此账号尚未授权。发送 /whoami 获取 ID，由服务管理员加入白名单。'); return; }
    await this.start();
    if (this.closing) return;
    const group = message.chat_type === 'group';
    const key = JSON.stringify([this.config.workspace, message.chat_id, group ? 'group' : user]);
    const match = prompt.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    const command = match?.[1];
    const args = match?.[2]?.trim() || '';
    if (command === 'help') { await send(help); return; }
    if (command === 'login') { await send('在 AWS 终端执行 sudo -u codex -H bash -lc \'cd /opt/codex-lark && npm run login:device\'，按提示用 ChatGPT 授权。无需在聊天中发送密码或 token。'); return; }
    if (command === 'tasks' || (command === 'status' && !args)) {
      const owned = this.owned(key);
      const pending = owned.filter(task => task.phase === 'running' || task.phase === 'queued').sort((a, b) => Number(a.phase === 'queued') - Number(b.phase === 'queued') || a.queuedAt - b.queuedAt);
      const recent = owned.filter(task => task.phase !== 'running' && task.phase !== 'queued').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
      const tasks = [...pending, ...recent];
      await send(`**并行执行：** ${this.active.size}/${this.config.parallel}${group ? '\n\n本群共用上下文，同群任务按顺序执行。' : ''}\n\n${tasks.length ? tasks.map(task => `- ${this.describe(task)}`).join('\n') : '当前会话空闲，尚无任务。'}\n\n用 /task 描述 创建独立任务，/continue 任务ID 描述 继续指定任务。`);
      return;
    }
    if (command === 'status' || command === 'result') {
      const task = this.find(key, args);
      if (!task) { await send('找不到你的任务。用 /tasks 查看任务 ID。'); return; }
      const runtime = this.active.get(task.id);
      await send(this.context(task, command === 'result' ? task.lastResult || '该任务尚无最终结果。' : `${this.describe(task)}${runtime ? `\n\n当前步骤：${inline(runtime.progress.step)}` : ''}`));
      return;
    }
    if (command === 'cancel') {
      const pending = this.owned(key).filter(task => task.phase === 'queued' || task.phase === 'running');
      const task = args ? this.find(key, args) : pending.length === 1 ? pending[0] : undefined;
      if (!task) { await send(pending.length > 1 && !args ? '有多个任务，请用 /cancel 任务ID 指定要取消的任务。\n\n' + pending.map(task => this.describe(task)).join('\n') : '找不到正在执行或排队的任务。'); return; }
      const runtime = task.phase === 'running' ? this.active.get(task.id) : undefined;
      if (runtime) {
        runtime.controller.abort(); runtime.progress.step = '正在取消任务';
        void this.ensureCard(task).then(card => card?.update(this.progress(task, runtime.progress))).catch(() => {});
        await send(`已请求取消 ${task.id}，已产生的文件修改会保留。`);
      } else if (task.phase === 'queued') {
        this.ready.delete(task.id); task.phase = 'cancelled'; task.updatedAt = Date.now();
        task.lastResult = '任务在排队期间已取消，未执行。'; await this.state.save();
        await this.finishCard(task); this.pump();
      } else await send('该任务已经结束。');
      return;
    }
    if (command === 'new' && !args) {
      delete this.state.data.current[key]; delete this.state.data.threads[key]; await this.state.save();
      await send('已切换到新会话，现有任务继续执行。下一条消息会创建独立任务。'); return;
    }
    let task: TaskRecord | undefined;
    if (command === 'continue') {
      const continuation = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!continuation) { await send('用法：/continue 任务ID 描述'); return; }
      task = this.find(key, continuation[1]!);
      if (!task) { await send('找不到你的任务。用 /tasks 查看任务 ID。'); return; }
      prompt = continuation[2]!;
      if (this.busy(task) && !group) { await send(`任务 ${task.id} 尚未结束。要并行执行其他工作，请用 /task 描述。`); return; }
    } else if (command === 'task' || command === 'new') {
      if (!args) { await send('用法：/task 描述'); return; }
      prompt = args;
    } else if (command) { await send(help); return; }
    else {
      if (group) task = this.current(key);
      else {
        task = this.owned(key).find(item => [message.parent_id, message.root_id].some(id => !!id && item.messageIds.includes(id)));
        if (task && this.busy(task)) { await send(`任务 ${task.id} 仍在执行。要并行创建新任务，请用 /task 描述。`); return; }
        if (!task) { task = this.current(key); if (task && this.busy(task)) task = undefined; }
      }
    }
    const pending = Object.values(this.state.data.tasks).filter(item => item.phase === 'queued').length;
    if (this.active.size + pending >= this.config.parallel + this.config.queued) { await send('并行名额和排队队列已满，请稍后重试。'); return; }
    const now = Date.now();
    if (!task || group) {
      const previousTaskId = task?.id;
      task = { ...(group ? { group: true, previousTaskId } : {}), id: this.newId(), ownerKey: key, title: prompt.replace(/\s+/g, ' ').slice(0, 80), prompt, phase: 'queued', createdAt: now, updatedAt: now, queuedAt: now, messageId: message.message_id, messageIds: [message.message_id] };
      this.state.data.tasks[task.id] = task;
    } else {
      task.prompt = prompt; task.phase = 'queued'; task.updatedAt = now; task.queuedAt = now;
      task.messageId = message.message_id; task.messageIds.push(message.message_id);
      delete task.cardId; this.cards.delete(task.id);
    }
    this.state.data.current[key] = task.id;
    await this.state.save();
    try {
      await this.ensureCard(task);
      if (!this.startTask) await send(`已收到任务 ${task.id}，等待执行。`);
      if (task.phase !== 'queued') return;
      this.ready.add(task.id); this.pump();
    } catch {
      task.phase = 'failed'; task.lastResult = '创建任务卡片失败，任务未执行。可用 /continue 任务ID 描述 重试。';
      await this.state.save(); await send(task.lastResult);
    }
  }

  private previousContext(task: TaskRecord): TaskRecord | undefined {
    const seen = new Set([task.id]);
    let id = task.previousTaskId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const previous = this.find(task.ownerKey, id);
      if (!previous) return;
      if (previous.workspace) return previous;
      id = previous.previousTaskId;
    }
  }

  private pump() {
    if (this.closing) return;
    while (this.active.size < this.config.parallel) {
      const task = Object.values(this.state.data.tasks).filter(item => item.phase === 'queued').sort((a, b) => a.queuedAt - b.queuedAt).find((item, index, queue) => {
        if (!this.ready.has(item.id) || (item.group && queue.slice(0, index).some(earlier => earlier.ownerKey === item.ownerKey))) return false;
        const previous = this.previousContext(item);
        const workspace = item.workspace || previous?.workspace;
        return ![...this.active.keys()].some(id => {
          const running = this.state.data.tasks[id]!;
          return (item.group && running.ownerKey === item.ownerKey) || (!!workspace && running.workspace === workspace);
        }) && !(item.previousTaskId && this.state.data.tasks[item.previousTaskId] && this.busy(this.state.data.tasks[item.previousTaskId]!));
      });
      if (!task) break;
      this.ready.delete(task.id); task.phase = 'running'; task.updatedAt = Date.now();
      const runtime: ActiveTask = { controller: new AbortController(), done: Promise.resolve(), progress: { step: '正在准备独立工作目录' } };
      this.active.set(task.id, runtime);
      runtime.done = this.execute(task, runtime).catch(() => console.error(`任务 ${task.id} 状态交付失败`)).finally(() => { this.active.delete(task.id); this.pump(); });
    }
  }

  private async execute(task: TaskRecord, runtime: ActiveTask) {
    const started = Date.now();
    let timedOut = false;
    let prepared = false;
    const timeout = setTimeout(() => { timedOut = true; runtime.controller.abort(); }, this.config.timeout);
    const update = () => { void this.ensureCard(task).then(card => card?.update(this.progress(task, runtime.progress, Date.now() - started))).catch(() => {}); };
    const heartbeat = setInterval(update, 60_000);
    try {
      await this.state.save(); update();
      if (task.group && !task.workspace) {
        const previous = this.previousContext(task);
        if (previous) {
          task.workspace = previous.workspace;
          task.branch = previous.branch;
          task.baseCommit = previous.baseCommit;
          task.threadId = previous.threadId;
        }
      }
      Object.assign(task, await this.workspaces.prepare(task));
      await this.state.save(); prepared = true;
      if (runtime.controller.signal.aborted) throw new Error('Aborted');
      runtime.progress = { step: '正在启动 Codex' }; update();
      const result = await this.runner.run(task.prompt, task.threadId, {
        signal: runtime.controller.signal, workingDirectory: task.workspace,
        onThread: async id => { task.threadId = id; await this.state.save(); },
        onProgress: progress => { runtime.progress = progress; update(); },
      });
      if (runtime.controller.signal.aborted) throw new Error('Aborted');
      task.phase = 'completed'; task.lastResult = result;
    } catch {
      task.phase = timedOut ? 'timeout' : this.closing ? 'interrupted' : runtime.controller.signal.aborted ? 'cancelled' : 'failed';
      task.lastResult = task.phase === 'failed'
        ? prepared ? `任务失败，请检查 ChatGPT 登录、模型权限和网络。可用 /continue ${task.id} 描述 重试。` : '独立目录准备失败。新任务需要有提交记录的 Git 仓库，CODEX_WORKSPACE 应指向仓库根目录；已有任务目录不能被删除。'
        : `任务${phaseLabels[task.phase]}，已有文件修改保留。可用 /continue ${task.id} 描述 继续。`;
      console.warn(`任务 ${task.id} ${phaseLabels[task.phase]}`);
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
    task.updatedAt = Date.now();
    await this.state.save();
    await this.finishCard(task, Date.now() - started);
  }

  async shutdown() {
    this.closing = true;
    for (const runtime of this.active.values()) runtime.controller.abort();
    await Promise.allSettled([...this.active.values()].map(runtime => runtime.done));
    await this.state.save();
  }
}

export function chunks(text: string, maxBytes = 12_000): string[] {
  const result: string[] = [];
  let chunk = ''; let bytes = 0;
  for (const char of text) {
    const length = Buffer.byteLength(char);
    if (bytes + length > maxBytes) { result.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += length;
  }
  if (chunk) result.push(chunk);
  return result;
}
