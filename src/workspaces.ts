import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codexEnvironment } from './runner.ts';
import type { TaskRecord } from './tasks.ts';

const exec = promisify(execFile);
export interface TaskWorkspaces {
  prepare(task: TaskRecord): Promise<{ workspace: string; branch?: string; baseCommit?: string }>;
}

export class GitWorkspaces implements TaskWorkspaces {
  private base: string;
  private root: string;
  private operations = Promise.resolve();
  constructor(base: string, root: string) { this.base = base; this.root = root; }

  private async git(args: string[], cwd = this.base) {
    const { stdout } = await exec('git', ['-C', cwd, ...args], {
      env: { ...codexEnvironment(), GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  prepare(task: TaskRecord) {
    const next = this.operations.then(() => this.prepareOne(task));
    this.operations = next.then(() => {}, () => {});
    return next;
  }

  private async prepareOne(task: TaskRecord) {
    if (task.workspace) {
      // 已有任务的文件丢失时直接失败，不能静默新建并丢弃旧修改。
      const actual = await realpath(task.workspace);
      const top = await this.git(['rev-parse', '--show-toplevel'], actual);
      if (await realpath(top) !== actual) throw new Error('InvalidTaskWorkspace');
      return { workspace: task.workspace, ...(task.branch ? { branch: task.branch } : {}), ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}) };
    }
    if (!/^t[a-f0-9]{8}$/.test(task.id)) throw new Error('InvalidTaskId');
    const top = await this.git(['rev-parse', '--show-toplevel']);
    if (await realpath(top) !== await realpath(this.base)) throw new Error('WorkspaceMustBeGitRoot');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const workspace = join(await realpath(resolve(this.root)), task.id);
    const branch = `codex/task-${task.id}`;
    // worktree 注册已成功、状态落盘前进程崩溃时，恢复同一个目录。
    const registered = (await this.git(['worktree', 'list', '--porcelain'])).split('\n\n').find(block => block.split('\n').includes(`worktree ${workspace}`));
    if (registered) {
      if (!registered.split('\n').includes(`branch refs/heads/${branch}`)) throw new Error('TaskBranchMismatch');
      await realpath(workspace);
      return { workspace, branch, baseCommit: registered.match(/^HEAD (.+)$/m)?.[1] };
    }
    const baseCommit = await this.git(['rev-parse', 'HEAD']);
    const existing = await this.git(['branch', '--list', branch]);
    if (existing) await this.git(['worktree', 'add', workspace, branch]);
    else await this.git(['worktree', 'add', '-b', branch, workspace, baseCommit]);
    return { workspace, branch, baseCommit };
  }
}
