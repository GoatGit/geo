'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, tokenStore } from '../../lib/api';

/** 登录(docs/01 §5):手机验证码,显式点击后才发送(docs/research 03 A8 对策)。 */
export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ devCode?: string }>('/auth/sms/code', { method: 'POST', json: { phone } });
      setDevCode(r.devCode ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ accessToken: string; refreshToken: string }>('/auth/sms/verify', {
        method: 'POST',
        json: { phone, code },
      });
      tokenStore.save(r.accessToken, r.refreshToken);
      router.replace('/dashboard');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-96 rounded-lg border bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">登录 GeoLens</h1>
        <p className="mb-6 text-sm text-slate-500">用中立数据回答:AI 推荐了你吗?</p>
        <input
          className="mb-3 w-full rounded border px-3 py-2 text-sm"
          placeholder="手机号"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <div className="mb-3 flex gap-2">
          <input
            className="w-full rounded border px-3 py-2 text-sm"
            placeholder="验证码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            className="whitespace-nowrap rounded bg-brand px-3 py-2 text-sm text-white disabled:opacity-50"
            disabled={busy || phone.length < 11}
            onClick={send}
          >
            获取验证码
          </button>
        </div>
        {devCode && (
          <p className="mb-3 rounded bg-cyan-50 px-3 py-2 text-xs text-cyan-700">
            dev 环境验证码:<span className="metric-num">{devCode}</span>
          </p>
        )}
        {error && <p className="mb-3 text-xs text-bad">{error}</p>}
        <button
          className="w-full rounded bg-brand py-2 text-sm font-medium text-white disabled:opacity-50"
          disabled={busy || code.length !== 6}
          onClick={verify}
        >
          登录 / 注册
        </button>
      </div>
    </div>
  );
}
