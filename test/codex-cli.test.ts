import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.ts';
import { createRunner } from '../src/runner.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-cli-test-'));
  const executable = join(dir, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = await readConfig({ CODEX_WORKSPACE: dir, CODEX_EXECUTABLE: executable, CODEX_MODEL: 'test-model' });
  return { dir, executable, runner: createRunner(config) };
}
const hooks = () => ({ signal: new AbortController().signal, onThread: async (_id: string) => {} });

test('全局 CLI 使用 stdin 收取提示词，保留续聊、目录、沙箱、模型与凭据过滤', async t => {
  const envKey = 'AWS_SECRET_ACCESS_KEY'; const original = process.env[envKey];
  process.env[envKey] = 'test-secret';
  t.after(async () => { if (original === undefined) delete process.env[envKey]; else process.env[envKey] = original; });
  const env = await fixture(t, `
let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk=>input+=chunk);
process.stdin.on('end', ()=>{
 const events=[{type:'thread.started',thread_id:'cli-thread'}, {type:'turn.started'},
 {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),hasAws:!!process.env.AWS_SECRET_ACCESS_KEY})}},
 {type:'turn.completed'}];
 const output=events.map(e=>JSON.stringify(e)).join('\\n')+'\\n';process.stdout.write(output.slice(0,20));process.stdout.write(output.slice(20));
});`);
  const workspace = join(env.dir, 'task'); await mkdir(workspace);
  const threads: string[] = [];
  const prompt = '中文 "引号" $(touch forbidden)\n第二行';
  const result = JSON.parse(await env.runner.run(prompt, 'existing-thread', { ...hooks(), workingDirectory: workspace, onThread: async id => { threads.push(id); } }));
  assert.deepEqual(threads, ['cli-thread']); assert.equal(result.input, prompt);
  assert.equal(await realpath(result.cwd), await realpath(workspace)); assert.equal(result.hasAws, false);
  assert.deepEqual(result.args, ['exec', '--json', '--sandbox', 'workspace-write', '--cd', workspace,
    '--skip-git-repo-check', '--config', 'approval_policy="never"', '--config', 'sandbox_workspace_write.network_access=false',
    '--model', 'test-model', 'resume', 'existing-thread', '-']);
  assert.ok(!result.args.includes(prompt));
});

test('缺失程序、非法 JSON、非零退出与没有完成事件均明确失败，不输出 stderr', async t => {
  for (const body of [
    `process.stdout.write('not json\\n');`,
    `process.stderr.write('secret-token');process.stdout.write('{"type":"turn.completed"}\\n');process.exitCode=2;`,
    `process.stdout.write('{"type":"turn.started"}\\n');`,
  ]) {
    const { runner } = await fixture(t, body);
    await assert.rejects(runner.run('test', undefined, hooks()), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret-token')); return true;
    });
  }
  const config = await readConfig({ CODEX_EXECUTABLE: '/nonexistent/codex' });
  await assert.rejects(createRunner(config).run('test', undefined, hooks()));
});

test('取消会终止 CLI 进程，预先取消时不启动程序', async t => {
  const env = await fixture(t, `
const fs=require('node:fs');fs.writeFileSync('started',String(process.pid));
process.stdin.resume();setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = env.runner.run('test', undefined, { ...hooks(), signal: controller.signal });
  const rejected = assert.rejects(pending);
  let pid = 0;
  const deadline = Date.now() + 3000;
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await readFile(join(env.dir, 'started'), 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(pid); controller.abort(); await rejected;
  assert.throws(() => process.kill(pid, 0));
  await rm(join(env.dir, 'started'));
  await assert.rejects(env.runner.run('test', undefined, { ...hooks(), signal: controller.signal }));
  await assert.rejects(readFile(join(env.dir, 'started')));
});
