import { codexEvents, type ThreadEvent } from './codex-cli.ts';
import type { Config } from './config.ts';
import type { TaskProgress } from './progress.ts';

export type RunHooks = {
  signal: AbortSignal;
  onThread(id: string): Promise<void>;
  onProgress?(progress: TaskProgress): void;
  workingDirectory?: string;
};
export interface Runner {
  run(prompt: string, threadId: string | undefined, hooks: RunHooks): Promise<string>;
}

export function progressForEvent(event: ThreadEvent): Partial<TaskProgress> | undefined {
  if (event.type === 'turn.started') return { step: '正在分析任务' };
  if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return;
  const item = event.item;
  switch (item.type) {
    case 'todo_list': return { step: '正在推进任务计划', plan: item.items };
    case 'agent_message': return { step: '正在生成回复', output: item.text, outputKind: 'markdown' };
    case 'command_execution': return {
      step: item.status === 'in_progress' ? '正在执行命令' : `命令已结束${item.exit_code === undefined ? '' : `（退出码 ${item.exit_code}）`}`,
      output: `$ ${item.command}\n${item.aggregated_output || ''}`, outputKind: 'text',
    };
    case 'file_change': return { step: '正在更新文件', output: item.changes.map(change => `${change.kind}: ${change.path}`).join('\n'), outputKind: 'text' };
    case 'mcp_tool_call': return { step: `调用工具 ${item.server}/${item.tool}` };
    case 'web_search': return { step: '正在搜索资料', output: item.query, outputKind: 'text' };
    // reasoning 不作为聊天进度输出。
    default: return;
  }
}

export async function consumeEvents(events: AsyncIterable<ThreadEvent>, hooks: RunHooks) {
  let final = '';
  let completed = false;
  let progress: TaskProgress = { step: '正在启动 Codex' };
  for await (const event of events) {
    if (event.type === 'thread.started') await hooks.onThread(event.thread_id);
    const update = progressForEvent(event);
    if (update) { progress = { ...progress, ...update }; hooks.onProgress?.(progress); }
    if (event.type === 'item.completed' && event.item.type === 'agent_message') final = event.item.text;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex turn failed');
  }
  if (!completed) throw new Error('Codex stream ended without completion');
  return final || '任务已完成，没有文本输出。';
}

export function codexEnvironment(env = process.env) {
  const result: Record<string, string> = {};
  // AWS/Lark 凭据不传递给执行任务的子进程。
  for (const name of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'CODEX_HOME', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE']) {
    if (env[name]) result[name] = env[name];
  }
  return result;
}

export function createRunner(config: Config): Runner {
  return {
    async run(prompt, threadId, hooks) {
      const events = codexEvents(prompt, threadId, {
        executable: config.codexExecutable,
        workspace: hooks.workingDirectory || config.workspace,
        sandbox: config.sandbox, env: codexEnvironment(), signal: hooks.signal,
        ...(config.model ? { model: config.model } : {}),
      });
      return consumeEvents(events, hooks);
    },
  };
}
