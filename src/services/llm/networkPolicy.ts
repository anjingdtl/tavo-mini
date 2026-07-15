import { LLMRequestError } from './requestPolicy';

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every(part => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

export function isPrivateLanHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!isIPv4(host)) return false;
  const [first, second] = host.split('.').map(Number);
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function validateLLMEndpoint(
  endpoint: string,
  allowInsecureLanHttp = false,
): URL {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new LLMRequestError(
      'API 地址格式不正确，请使用 https:// 开头的地址。',
      'provider_error',
    );
  }

  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') {
    throw new LLMRequestError(
      'API 地址只支持 HTTPS，或受控的局域网 HTTP。',
      'provider_error',
    );
  }
  if (!allowInsecureLanHttp || !isPrivateLanHost(url.hostname)) {
    throw new LLMRequestError(
      '已阻止不安全 HTTP 地址。仅开启“允许不安全的局域网 HTTP 服务”后，才能连接 127.0.0.1、10/8、172.16/12 或 192.168/16。',
      'insecure_http_blocked',
    );
  }
  return url;
}

export function assertAllowedLLMEndpoint(
  endpoint: string,
  allowInsecureLanHttp = false,
): void {
  validateLLMEndpoint(endpoint, allowInsecureLanHttp);
}
