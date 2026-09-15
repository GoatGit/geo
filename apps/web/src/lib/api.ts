'use client';

/** API 客户端:Bearer token 注入 + 错误包络解析。dev 经 Next rewrites 同源代理。 */
const TOKEN_KEY = 'geo.accessToken';
const REFRESH_KEY = 'geo.refreshToken';
const BRAND_KEY = 'geo.brandId';
const ACCOUNT_KEY = 'geo.account';

export interface SessionAccount {
  accountId: number;
  phone: string;
  role?: string;
}

export const accountStore = {
  get(): SessionAccount | null {
    if (typeof window === 'undefined') return null;
    const v = localStorage.getItem(ACCOUNT_KEY);
    if (!v) return null;
    try {
      return JSON.parse(v) as SessionAccount;
    } catch {
      return null;
    }
  },
  save(account: SessionAccount) {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  },
};

export const isAdmin = () => accountStore.get()?.role === 'admin';

export const tokenStore = {
  get access() {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(TOKEN_KEY);
  },
  save(access: string, refresh: string) {
    localStorage.setItem(TOKEN_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(BRAND_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
  },
};

export const brandStore = {
  get(): number | null {
    if (typeof window === 'undefined') return null;
    const v = localStorage.getItem(BRAND_KEY);
    return v ? Number(v) : null;
  },
  set(id: number) {
    localStorage.setItem(BRAND_KEY, String(id));
  },
};

export class ApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown; /** 公开接口:不携带凭证,401 也不触发跳登录(如官网首页) */ auth?: boolean },
): Promise<T> {
  const token = init?.auth === false ? null : tokenStore.access;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (res.status === 401 && init?.auth !== false && typeof window !== 'undefined') {
    tokenStore.clear();
    const { buildLoginUrl } = await import('./login-reasons');
    window.location.href = buildLoginUrl('session', location.pathname + location.search);
    throw new ApiError(401, '未登录');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/** 二进制下载(带凭证):PDF 等附件;失败时按错误包络解析并抛出。 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const token = tokenStore.access;
  const res = await fetch(`/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  const filename = utf8 ? decodeURIComponent(utf8) : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
