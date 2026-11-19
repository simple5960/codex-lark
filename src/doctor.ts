import { spawnSync } from 'node:child_process';
import { readConfig } from './config.ts';
import { loadCredentials } from './secrets.ts';
import { createLark, checkBot } from './lark.ts';
import { errorSummary } from './errors.ts';

try {
  const config = await readConfig();
  console.log(`工作目录：${config.workspace}\nAWS 区域：${config.region || '默认凭据配置'}\nLark 平台：${config.domain}\n授权用户数：${config.allowed.size}`);
  const credentials = await loadCredentials(config.secretId, config.region);
  console.log('AWS Secret：读取成功，必需字段齐全（不显示凭据）');
  const { client } = createLark(credentials, config.domain);
  const name = await checkBot(client);
  console.log(`Lark 应用：验证成功${name ? `（${name}）` : ''}`);
  const version = spawnSync(config.codexExecutable, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error('GlobalCodexNotFound');
  console.log(`全局 Codex：${config.codexExecutable}`);
  const login = spawnSync(config.codexExecutable, ['login', 'status'], { encoding: 'utf8' });
  if (login.status !== 0) throw new Error('CodexLoginRequired');
  console.log('Codex 登录：有效（可通过 npm run login 切换到 ChatGPT 登录）');
} catch (error) {
  console.error(`检查失败：${errorSummary(error)}。请核对区域、Secret、IAM、应用机器人能力和 Codex 登录。`);
  process.exitCode = 1;
}
