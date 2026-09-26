'use client';

/**
 * 微信扫码登录回调(open.weixin.qq.com 授权后重定向至此):
 * 携带 ?code=&state= → POST /auth/wechat/exchange 换本站 JWT → 存储后跳转。
 * state 前后端双重校验(发起时存 sessionStorage,后端 HMAC 验签 + 10 分钟时效)。
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, accountStore, tokenStore, type SessionAccount } from '@/lib/api';

export default function WechatCallbackPage() {
  const router = useRouter();
  const ranRef = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const savedState = sessionStorage.getItem('wx_state');

    if (!code || !state) {
      setError('缺少授权参数,请从登录页重新发起');
      return;
    }
    if (savedState && savedState !== state) {
      setError('state 不匹配,请从登录页重新发起');
      return;
    }
    sessionStorage.removeItem('wx_state');
    sessionStorage.removeItem('wx_next');

    (async () => {
      try {
        // 诊断模式:直连 exchange 并展示微信侧真实错误(不走 api() 的 401 自动跳登录)
        const res = await fetch('/api/auth/wechat/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, state }),
        });
        const bodyText = await res.text();
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { msg = JSON.parse(bodyText)?.error?.message ?? bodyText.slice(0, 150); } catch { msg = bodyText.slice(0, 150); }
          setError(`授权失败:${msg}`);
          return;
        }
        const r = JSON.parse(bodyText) as { accessToken: string; refreshToken: string; account: SessionAccount };
        tokenStore.save(r.accessToken, r.refreshToken);
        if (r.account) accountStore.save(r.account);
        const next = sessionStorage.getItem('wx_next');
        sessionStorage.removeItem('wx_next');
        router.replace(next || '/dashboard');
      } catch (e) {
        setError((e as Error).message || '微信登录失败,请重试');
      }
    })();
  }, [router]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-sm text-slate-500">
      {error ? (
        <>
          <p className="text-bad">{error}</p>
          <a href="/login" className="btn-primary mt-2">
            返回登录
          </a>
        </>
      ) : (
        <>
          <span className="animate-pulse-soft text-brand-600">●</span>
          <span>微信授权成功,正在登录…</span>
        </>
      )}
    </div>
  );
}
