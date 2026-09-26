'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, accountStore, tokenStore, type SessionAccount } from '../../lib/api';
import { LOGIN_REASONS, loginReasonKey, safeNext } from '../../lib/login-reasons';
import { IconArrowRight, IconCheck, IconShield } from '../../components/icons';
import { LogoMark } from '../../components/logo';

const VALUE_POINTS = [
  { title: '看见', text: '中立账号向 5 大 AI 引擎批量提问,量化提及率、推荐位次与引用来源' },
  { title: '可信', text: '每个数字可下钻到原始回答与快照存证,分子/分母全程透明' },
  { title: '可行动', text: '问题分层与缺口定位,输出可直接交付的行动清单' },
];

/** 登录(docs/01 §5):左品牌叙事右表单;验证码显式点击才发送(docs/research 03 A8 对策)。 */
export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [reasonKey, setReasonKey] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);

  // 跳转场景:所有跳登录的入口都带 reason(为什么登录)+ next(登录后回跳)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setReasonKey(loginReasonKey(params.get('reason')));
    setNext(params.get('next'));
    document.title = '登录 · 格尺GEO';
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const send = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ devCode?: string }>('/auth/sms/code', { method: 'POST', json: { phone } });
      setDevCode(r.devCode ?? null);
      setCountdown(60);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 微信扫码登录:先从后端取带 state 的 qrconnect 地址,跳过去;授权后回跳 /auth/wechat/callback
  const wechatLogin = async () => {
    setError('');
    try {
      const nextPath = safeNext(next);
      const r = await api<{ url: string; state: string }>('/auth/wechat/url');
      sessionStorage.setItem('wx_state', r.state);
      sessionStorage.setItem('wx_next', nextPath);
      window.location.href = r.url;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const verify = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ accessToken: string; refreshToken: string; account: SessionAccount }>('/auth/sms/verify', {
        method: 'POST',
        json: { phone, code },
      });
      tokenStore.save(r.accessToken, r.refreshToken);
      if (r.account) accountStore.save(r.account);
      router.replace(safeNext(next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* 左:品牌叙事 */}
      <div className="relative hidden overflow-hidden bg-ink-950 lg:block">
        <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 animate-float-slow rounded-full bg-brand-500/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-[28rem] w-[28rem] rounded-full bg-sand/10 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[.35]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(103,232,249,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(103,232,249,.06) 1px, transparent 1px)',
            backgroundSize: '44px 44px',
          }}
        />

        <div className="relative flex h-full flex-col justify-between p-12">
          <Link href="/" className="rise flex items-center gap-2.5">
            <LogoMark className="h-9 w-9" />
            <span>
              <span className="block text-base font-semibold leading-4 text-white">格尺GEO</span>
            </span>
          </Link>

          <div className="max-w-lg">
            <h1 className="rise text-[34px] font-semibold leading-[1.25] tracking-tight text-white">
              当用户问 AI 时,
              <br />
              你的品牌
              <span className="bg-gradient-to-r from-brand-300 to-sand-300 bg-clip-text text-transparent">
                被推荐了吗
              </span>
              ?
            </h1>
            <p className="rise-1 mt-4 text-[15px] leading-7 text-slate-400">
              用中立数据回答:排第几、谁被引用、口碑如何 —— 每一个数字都能回溯到原始回答与快照。
            </p>
            <ul className="rise-2 mt-9 space-y-5">
              {VALUE_POINTS.map((v) => (
                <li key={v.title} className="flex gap-3.5">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-500/15 text-brand-300">
                    <IconCheck width={13} height={13} />
                  </span>
                  <span>
                    <b className="text-sm font-semibold text-slate-100">{v.title}</b>
                    <span className="ml-2 text-sm leading-6 text-slate-400">{v.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="rise-3 text-xs text-slate-600">
            豆包 · DeepSeek · 文心一言 · 通义千问 · 腾讯元宝 —— 5 大引擎,每日中立监测
          </p>
        </div>
      </div>

      {/* 右:表单 */}
      <div className="flex items-center justify-center bg-white px-6">
        <div className="rise w-full max-w-sm">
          <div className="lg:hidden">
            <LogoMark className="mb-6 h-10 w-10" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">登录 / 注册</h2>
          <p className="mt-1.5 text-sm text-slate-500">未注册的手机号验证后将自动创建账号</p>

          {reasonKey && LOGIN_REASONS[reasonKey] && (
            <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-brand-100 bg-brand-50 px-3.5 py-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-brand-600 shadow-sm">
                <IconShield width={13} height={13} />
              </span>
              <span>
                <p className="text-[13px] font-semibold leading-5 text-brand-700">{LOGIN_REASONS[reasonKey].title}</p>
                {LOGIN_REASONS[reasonKey].desc && (
                  <p className="mt-0.5 text-xs leading-5 text-brand-600/80">{LOGIN_REASONS[reasonKey].desc}</p>
                )}
              </span>
            </div>
          )}

          <div className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">手机号</label>
              <input
                className="input h-11"
                placeholder="请输入手机号"
                maxLength={11}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">验证码</label>
              <div className="flex gap-2">
                <input
                  className="input h-11 flex-1"
                  placeholder="6 位验证码"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && !busy && verify()}
                />
                <button
                  className="btn-soft h-11 shrink-0 px-4 disabled:opacity-40"
                  disabled={busy || phone.length !== 11 || countdown > 0}
                  onClick={send}
                >
                  {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                </button>
              </div>
            </div>

            {devCode && (
              <div className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-xs text-brand-700">
                <span className="animate-pulse-soft">●</span>
                dev 环境验证码:
                <b className="metric-num text-sm">{devCode}</b>
                <span className="ml-auto text-brand-500">仅开发环境显示</span>
              </div>
            )}
            {error && (
              <p className="rounded-lg bg-bad-50 px-3 py-2 text-xs leading-5 text-bad">{error}</p>
            )}

            <button
              className="btn-primary h-11 w-full text-[15px]"
              disabled={busy || code.length !== 6}
              onClick={verify}
            >
              登录 / 注册
              <IconArrowRight width={15} height={15} />
            </button>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-400">或</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>
            <button
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-[#07c160] text-[15px] font-medium text-white hover:opacity-90"
              onClick={() => void wechatLogin()}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8.69 3.5C4.98 3.5 2 6.05 2 9.2c0 1.77.94 3.35 2.4 4.4l-.6 1.87 2.11-1.06c.72.19 1.5.3 2.28.32a5.23 5.23 0 0 1-.13-1.14c0-3 2.94-5.42 6.56-5.42.23 0 .46.01.68.03C16.63 5.47 12.95 3.5 8.69 3.5zM6.5 7.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7zm4.9 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7zM15.72 9.7c-3.13 0-5.72 2.06-5.72 4.65 0 2.6 2.59 4.66 5.72 4.66.67 0 1.31-.1 1.91-.28l1.75.88-.47-1.53a4.65 4.65 0 0 0 2.25-3.73c0-2.58-2.57-4.65-5.72-4.65h.28zm-2.1 2.3a.72.72 0 1 1 0 1.44.72.72 0 0 1 0-1.44zm3.75 0a.72.72 0 1 1 0 1.44.72.72 0 0 1 0-1.44z" />
              </svg>
              微信扫码登录
            </button>

            <p className="text-center text-[11px] leading-5 text-slate-400">
              登录即代表同意《服务协议》与《隐私政策》
              <br />
              <Link href="/" className="text-slate-400 underline-offset-2 hover:text-brand-600 hover:underline">
                返回官网
              </Link>
              <br />
              <a
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:text-slate-600 hover:underline"
              >
                京ICP备2024074563号-9
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
