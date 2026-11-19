import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

loadEnv({ path: '.env.prod', quiet: true });

export async function readConfig(env = process.env) {
  const workspace = resolve(env.CODEX_WORKSPACE || process.cwd());
  if (!(await stat(workspace)).isDirectory()) throw new Error('CODEX_WORKSPACE 必须是已存在的目录');
  const domain = env.LARK_DOMAIN || 'lark';
  if (!['lark', 'feishu'].includes(domain)) throw new Error('LARK_DOMAIN 必须是 lark 或 feishu');
  const sandbox = env.CODEX_SANDBOX || 'workspace-write';
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('CODEX_SANDBOX 仅支持 read-only 或 workspace-write');
  const timeout = Number(env.TASK_TIMEOUT_MS || 1_800_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('TASK_TIMEOUT_MS 必须是 >= 1000 的整数');
  const parallel = Number(env.MAX_PARALLEL_TASKS || 2);
  const queued = Number(env.MAX_QUEUED_TASKS || 20);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('MAX_PARALLEL_TASKS 必须在 1 到 8 之间');
  if (!Number.isInteger(queued) || queued < 0 || queued > 100) throw new Error('MAX_QUEUED_TASKS 必须在 0 到 100 之间');
  return {
    workspace, domain: domain as 'lark' | 'feishu',
    sandbox: sandbox as 'read-only' | 'workspace-write', timeout,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION,
    secretId: env.AWS_SECRET_ID || 'simple-codex',
    allowed: new Set((env.ALLOWED_OPEN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    model: env.CODEX_MODEL,
    codexExecutable: env.CODEX_EXECUTABLE || 'codex',
    statePath: resolve('.data/state.json'),
    parallel, queued, worktreeRoot: resolve(env.TASK_WORKTREE_ROOT || '.data/worktrees'),
  };
}
export type Config = Awaited<ReturnType<typeof readConfig>>;
