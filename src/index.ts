import * as lark from '@larksuiteoapi/node-sdk';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig } from './config.ts';
import { loadCredentials } from './secrets.ts';
import { State } from './state.ts';
import { Bridge } from './bridge.ts';
import { createRunner } from './runner.ts';
import { createLark, checkBot } from './lark.ts';
import { errorSummary } from './errors.ts';

async function main() {
  const config = await readConfig();
  await mkdir(dirname(config.statePath), { recursive: true, mode: 0o700 });
  const lockPath = config.statePath + '.lock';
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('服务锁已存在，请确认无其他实例；异常退出后可删除 .data/state.json.lock'); });
  let bridge: Bridge | undefined;
  let ws: ReturnType<typeof createLark>['ws'] | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    ws?.close({ force: true });
    await bridge?.shutdown();
    await lock.close();
    await unlink(lockPath);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try {
    const credentials = await loadCredentials(config.secretId, config.region);
    const transport = createLark(credentials, config.domain);
    ws = transport.ws;
    await checkBot(transport.client);
    const state = new State(config.statePath);
    await state.load();
    bridge = new Bridge(config, state, createRunner(config), transport.reply, transport.startTask);
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async event => {
        try { await bridge!.receive(event); }
        catch { console.error('消息处理失败（未记录消息或原始异常）'); }
      },
    });
    if (stopping) return;
    await ws.start({ eventDispatcher: dispatcher });
    console.log(`Lark 连接状态：${ws.getConnectionStatus().state}；工作目录：${config.workspace}；授权用户数：${config.allowed.size}`);
    if (!config.allowed.size) console.log('请私聊机器人发送 /whoami，再配置 ALLOWED_OPEN_IDS 并重启。');
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch(error => {
  // AWS 异常可能含请求内容，仅输出错误类型。
  console.error(`启动失败：${errorSummary(error)}。请核对 AWS 区域、Secret、IAM 权限、机器人能力、本地配置和服务锁。`);
  process.exitCode = 1;
});
