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

type BrandListener = () => void;
const brandListeners = new Set<BrandListener>();

export const brandStore = {
  get(): number | null {
    if (typeof window === 'undefined') return null;
    const v = localStorage.getItem(BRAND_KEY);
    if (!v) return null;
    const n = Number(v);
    // 脏值('undefined'/'abc')归一为 null,避免 enabled:!!NaN 放行发出 brand=NaN 请求
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  set(id: number) {
    localStorage.setItem(BRAND_KEY, String(id));
    // 通知订阅者(React 端经 useSyncExternalStore 订阅),切换品牌免整页刷新
    brandListeners.forEach((l) => l());
  },
  /** 订阅品牌变化(供 useSyncExternalStore);返回退订函数。 */
  subscribe(listener: BrandListener): () => void {
    brandListeners.add(listener);
    return () => {
      brandListeners.delete(listener);
    };
  },
};

export class ApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** 401 单飞刷新:并发请求只触发一次 refresh,成功后重放原请求(消灭 2h 强制掉线)。 */
let refreshing: Promise<boolean> | null = null;

async function tryRefreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = localStorage.getItem(REFRESH_KEY);
      if (!refreshToken) return false;
      try {
        const res = await fetch('/api/auth/token:refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { accessToken?: string; refreshToken?: string; account?: SessionAccount };
        if (!body.accessToken) return false;
        localStorage.setItem(TOKEN_KEY, body.accessToken);
        if (body.refreshToken) localStorage.setItem(REFRESH_KEY, body.refreshToken);
        if (body.account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(body.account));
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** 鉴权请求通用参数(auth=false 为公开接口;_retried401 防刷新后无限重放)。 */
type AuthedInit = RequestInit & {
  /** 公开接口:不携带凭证,401 也不触发跳登录(如官网首页) */
  auth?: boolean;
  /** 内部标记:401 刷新后已重放一次,再次 401 不再重试 */
  _retried401?: boolean;
};

/**
 * 底层请求(JSON 与二进制下载两条路径共用):Bearer 注入 + 401 单飞刷新后重放一次。
 * 刷新失败时清凭证并携场景化理由跳登录页,再抛 401 ApiError。
 */
async function requestWithAuth(path: string, init: AuthedInit): Promise<Response> {
  const token = init.auth === false ? null : tokenStore.access;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && init.auth !== false && !init._retried401 && typeof window !== 'undefined') {
    if (await tryRefreshAccessToken()) {
      return requestWithAuth(path, { ...init, _retried401: true });
    }
    tokenStore.clear();
    const { buildLoginUrl } = await import('./login-reasons');
    window.location.href = buildLoginUrl('session', location.pathname + location.search);
    throw new ApiError(401, '未登录');
  }
  return res;
}

export async function api<T>(
  path: string,
  init?: RequestInit & {
    json?: unknown;
    /** 公开接口:不携带凭证,401 也不触发跳登录(如官网首页) */
    auth?: boolean;
    /** 内部标记:401 刷新后已重放一次,再次 401 不再重试 */
    _retried401?: boolean;
  },
): Promise<T> {
  const res = await requestWithAuth(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/** 二进制下载(带凭证):PDF 等附件;401 同样单飞刷新后重试一次;失败按错误包络解析并抛出。 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const res = await requestWithAuth(path, {});
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
