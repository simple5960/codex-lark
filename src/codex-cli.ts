import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// codex exec --json 的公开事件格式；仅声明桥接服务消费的字段。
type Item = { id?: string } & (
  | { type: 'todo_list'; items: { text: string; completed: boolean }[] }
  | { type: 'agent_message' | 'reasoning'; text: string }
  | { type: 'command_execution'; command: string; aggregated_output?: string; exit_code?: number; status: string }
  | { type: 'file_change'; changes: { kind: string; path: string }[]; status?: string }
  | { type: 'mcp_tool_call'; server: string; tool: string }
  | { type: 'web_search'; query: string }
  | { type: 'error'; message: string }
);
export type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: Record<string, number> }
  | { type: 'turn.failed'; error?: unknown }
  | { type: 'error'; message?: string }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: Item };

type CliOptions = {
  executable: string; workspace: string; sandbox: 'read-only' | 'workspace-write';
  env: Record<string, string>; signal: AbortSignal; model?: string;
};

export async function* codexEvents(prompt: string, threadId: string | undefined, options: CliOptions): AsyncGenerator<ThreadEvent> {
  if (options.signal.aborted) throw new Error('CodexAborted');
  const args = ['exec', '--json', '--sandbox', options.sandbox, '--cd', options.workspace,
    '--skip-git-repo-check', '--config', 'approval_policy="never"',
    '--config', 'sandbox_workspace_write.network_access=false'];
  if (options.model) args.push('--model', options.model);
  if (threadId) args.push('resume', threadId);
  args.push('-'); // 提示词通过 stdin 传递，不进入进程参数或 shell。
  const child = spawn(options.executable, args, {
    cwd: options.workspace, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let spawnError = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => { spawnError = true; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // 不缓存或输出 stderr，其中可能包含模型输出、工具内容或认证信息。
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* 进程可能已退出。 */ }
  };
  const stop = () => {
    kill('SIGTERM');
    forceKill ??= setTimeout(() => kill('SIGKILL'), 5000);
    forceKill.unref();
  };
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  child.stdin.end(prompt);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as ThreadEvent;
      if (!event || typeof event.type !== 'string') throw new Error('InvalidCodexEvent');
      yield event;
    }
    const result = await completion;
    if (options.signal.aborted) throw new Error('CodexAborted');
    if (spawnError || result.code !== 0 || result.signal) throw new Error('CodexExecutionFailed');
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) stop();
    await completion;
    options.signal.removeEventListener('abort', stop);
    if (forceKill) { kill('SIGKILL'); clearTimeout(forceKill); }
  }
}
