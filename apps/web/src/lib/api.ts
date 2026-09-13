'use client';

/** API 客户端:Bearer token 注入 + 错误包络解析。dev 经 Next rewrites 同源代理。 */
const TOKEN_KEY = 'geo.accessToken';
const REFRESH_KEY = 'geo.refreshToken';
const BRAND_KEY = 'geo.brandId';

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

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const token = tokenStore.access;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    tokenStore.clear();
    window.location.href = '/login';
    throw new ApiError(401, '未登录');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}
