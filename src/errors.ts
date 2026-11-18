// 仅提取稳定的错误类型、HTTP 状态码和服务错误码；不序列化请求/响应对象。
export function errorSummary(error: unknown) {
  if (!error || typeof error !== 'object') return 'UnknownError';
  const value = error as { name?: unknown; code?: unknown; response?: { status?: unknown; data?: { code?: unknown } } };
  const name = typeof value.name === 'string' && /^[A-Za-z0-9_]+$/.test(value.name) ? value.name : 'Error';
  const parts = [name];
  if (typeof value.response?.status === 'number') parts.push(`HTTP ${value.response.status}`);
  if (typeof value.response?.data?.code === 'number') parts.push(`API ${value.response.data.code}`);
  if (typeof value.code === 'number') parts.push(`API ${value.code}`);
  return parts.join(' / ');
}
