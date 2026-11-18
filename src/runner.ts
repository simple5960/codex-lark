import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import type { Config } from './config.ts';

export type RunHooks = {
  signal: AbortSignal;
  onThread(id: string): Promise<void>;
};
export interface Runner {
  run(prompt: string, threadId: string | undefined, hooks: RunHooks): Promise<string>;
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
  const codex = new Codex({ env: codexEnvironment() });
  const options: ThreadOptions = {
    workingDirectory: config.workspace,
    sandboxMode: config.sandbox,
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    skipGitRepoCheck: true,
    ...(config.model ? { model: config.model } : {}),
  };
  return {
    async run(prompt, threadId, hooks) {
      const thread = threadId ? codex.resumeThread(threadId, options) : codex.startThread(options);
      const { events } = await thread.runStreamed(prompt, { signal: hooks.signal });
      let final = '';
      let completed = false;
      for await (const event of events) {
        if (event.type === 'thread.started') await hooks.onThread(event.thread_id);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') final = event.item.text;
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex turn failed');
      }
      if (!completed) throw new Error('Codex stream ended without completion');
      return final || '任务已完成，没有文本输出。';
    },
  };
}
