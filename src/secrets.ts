import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export function parseSecret(value: string) {
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object') throw new Error('AWS Secret 必须是 JSON 对象');
  const fields = data as Record<string, unknown>;
  const appId = fields['simple-codex-app-id'];
  const appSecret = fields['simple-codex-app-secret'];
  if (typeof appId !== 'string' || !appId.trim() || typeof appSecret !== 'string' || !appSecret.trim()) {
    throw new Error('Secret 缺少 simple-codex-app-id / simple-codex-app-secret');
  }
  return { appId, appSecret };
}

export async function loadCredentials(secretId: string, region?: string) {
  const client = new SecretsManagerClient(region ? { region } : {});
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = result.SecretString ?? (result.SecretBinary && Buffer.from(result.SecretBinary).toString('utf8'));
    if (!value) throw new Error('AWS Secret 内容为空');
    return parseSecret(value);
  } finally { client.destroy(); }
}
