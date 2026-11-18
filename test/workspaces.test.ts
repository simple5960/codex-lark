import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorkspaces } from '../src/workspaces.ts';
import { State } from '../src/state.ts';
import { readConfig } from '../src/config.ts';
import type { TaskRecord } from '../src/tasks.ts';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec('git', ['-C', cwd, ...args])).stdout.trim(); }
function task(id: string): TaskRecord {
  return { id, ownerKey: 'owner', title: 'test', prompt: 'test', phase: 'queued', createdAt: 0, updatedAt: 0, queuedAt: 0, messageId: 'om_test', messageIds: [] };
}
async function repo(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-worktrees-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'repo'); await mkdir(base);
  await git(base, 'init', '-q');
  await git(base, 'config', 'user.name', 'Codex test'); await git(base, 'config', 'user.email', 'test@example.com');
  await writeFile(join(base, 'shared.txt'), 'committed baseline\n');
  await git(base, 'add', 'shared.txt'); await git(base, 'commit', '-m', 'initial');
  return { dir, base, manager: new GitWorkspaces(base, join(dir, 'tasks')) };
}

test('并行任务使用真实独立 worktree，同文件写入不互相覆盖，也不修改原目录', async t => {
  const { manager, base } = await repo(t);
  await writeFile(join(base, 'shared.txt'), 'uncommitted base work\n');
  const [a, b] = await Promise.all([manager.prepare(task('t11111111')), manager.prepare(task('t22222222'))]);
  assert.notEqual(a.workspace, b.workspace); assert.notEqual(a.branch, b.branch);
  assert.equal(await readFile(join(a.workspace, 'shared.txt'), 'utf8'), 'committed baseline\n');
  await Promise.all([writeFile(join(a.workspace, 'shared.txt'), 'task A\n'), writeFile(join(b.workspace, 'shared.txt'), 'task B\n')]);
  assert.equal(await readFile(join(a.workspace, 'shared.txt'), 'utf8'), 'task A\n');
  assert.equal(await readFile(join(b.workspace, 'shared.txt'), 'utf8'), 'task B\n');
  assert.equal(await readFile(join(base, 'shared.txt'), 'utf8'), 'uncommitted base work\n');
  assert.equal(await git(a.workspace, 'branch', '--show-current'), a.branch);
  assert.equal(await git(b.workspace, 'branch', '--show-current'), b.branch);
});

test('状态落盘前崩溃也能恢复原 worktree；恢复不会覆盖未提交修改', async t => {
  const { manager } = await repo(t);
  const record = task('t33333333');
  const first = await manager.prepare(record);
  await writeFile(join(first.workspace, 'shared.txt'), 'keep edits\n');
  const recovered = await manager.prepare(record);
  assert.equal(recovered.workspace, first.workspace);
  assert.equal(await readFile(join(recovered.workspace, 'shared.txt'), 'utf8'), 'keep edits\n');
  Object.assign(record, recovered);
  assert.equal((await manager.prepare(record)).workspace, first.workspace);
});

test('旧目录原样复用；非 Git 仓库、未提交仓库、非法 ID 和丢失目录失败', async t => {
  const { manager, base, dir } = await repo(t);
  const legacy = task('t44444444'); legacy.workspace = base;
  assert.equal(await realpath((await manager.prepare(legacy)).workspace), await realpath(base));
  await assert.rejects(manager.prepare(task('../outside')));
  legacy.workspace = join(dir, 'missing'); await assert.rejects(manager.prepare(legacy));
  const empty = join(dir, 'empty'); await mkdir(empty);
  const invalid = new GitWorkspaces(empty, join(dir, 'invalid-tasks'));
  await assert.rejects(invalid.prepare(task('t55555555')));
  await git(empty, 'init', '-q'); await assert.rejects(invalid.prepare(task('t55555555')));
});

test('旧版状态可读取，新增任务状态与白名单配置校验', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-state-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ threads: { old: 'thread' }, seen: { message: Date.now() } }));
  const state = new State(path); await state.load();
  assert.equal(state.data.threads.old, 'thread'); assert.deepEqual(state.data.tasks, {}); assert.deepEqual(state.data.current, {});
  state.data.tasks.t66666666 = task('t66666666'); await state.save();
  const restored = new State(path); await restored.load(); assert.deepEqual(restored.data, state.data);
  assert.equal((await readConfig({ CODEX_WORKSPACE: dir })).parallel, 2);
  await assert.rejects(readConfig({ CODEX_WORKSPACE: dir, MAX_PARALLEL_TASKS: '0' }));
  await assert.rejects(readConfig({ CODEX_WORKSPACE: dir, MAX_QUEUED_TASKS: '-1' }));
});
