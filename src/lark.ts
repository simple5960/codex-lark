import * as lark from '@larksuiteoapi/node-sdk';
import { createMarkdownReply } from './messages.ts';

export async function checkBot(client: lark.Client) {
  const result = await client.request<{ code: number; bot?: { app_name?: string } }>({ method: 'GET', url: '/open-apis/bot/v3/info/' });
  if (result.code !== 0) {
    const error = new Error('Lark bot check failed') as Error & { code: number };
    error.name = result.code === 11205 ? 'BotNotEnabled' : 'BotCheckFailed';
    error.code = result.code;
    throw error;
  }
  return result.bot?.app_name;
}

export function createLark(credentials: { appId: string; appSecret: string }, domain: 'lark' | 'feishu') {
  // 不将 SDK 原始错误或 HTTP 请求对象写入日志，里面可能带 appSecret/token。
  const logger = {
    trace: (..._args: unknown[]) => {}, debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => { console.warn('Lark SDK 警告'); },
    error: (..._args: unknown[]) => { console.error('Lark SDK 错误，请检查应用配置或网络'); },
  };
  const options = { ...credentials, domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu, logger };
  const client = new lark.Client({ ...options, appType: lark.AppType.SelfBuild });
  const ws = new lark.WSClient({
    ...options, loggerLevel: lark.LoggerLevel.warn, handshakeTimeoutMs: 15_000,
    onReady: () => console.log('Lark WebSocket 已连接'),
    onReconnecting: () => console.log('Lark WebSocket 正在重连'),
    onReconnected: () => console.log('Lark WebSocket 已恢复连接'),
    onError: () => console.error('Lark WebSocket 连接失败，请检查后台长连接设置及网络'),
  });
  const reply = createMarkdownReply((messageId, data) => client.im.message.reply({
    path: { message_id: messageId }, data,
  }));
  return { client, ws, reply };
}
