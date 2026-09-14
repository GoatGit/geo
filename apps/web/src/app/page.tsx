'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { tokenStore } from '../lib/api';
import {
  IconArrowRight,
  IconCheck,
  IconCite,
  IconEye,
  IconLogo,
  IconShield,
  IconSpark,
} from '../components/icons';

const ENGINES = ['豆包', 'DeepSeek', '文心一言', '通义千问', '腾讯元宝'];

const VALUES = [
  {
    icon: <IconEye />,
    title: '看见',
    text: '中立账号向主流 AI 引擎批量提问,量化品牌的提及率、推荐位次、口碑倾向与引用来源。',
  },
  {
    icon: <IconShield />,
    title: '可信',
    text: '每一条数据都能回放到原始回答与快照存证,指标口径(分子/分母)全程透明可查。',
  },
  {
    icon: <IconSpark />,
    title: '可行动',
    text: '把监测数据转成问题分层、缺口定位与优先级行动建议,输出可直接交付的报告。',
  },
];

const EVIDENCE = [
  {
    title: '快照存证,逐条可回溯',
    text: '每次采集绑定回答原文、页面快照与哈希清单。报告里的每一个数字,三次点击内到达原始证据。',
  },
  {
    title: '分子/分母,口径透明',
    text: '提及率、Top3 率、首推率的分母规则公开可查,口径徽章随手可看——不给你看不懂的百分比。',
  },
  {
    title: '失败与空,绝不冒充零',
    text: '采集失败与「没人提及」是两种状态。四态状态机保证任何页面都不把失败静默显示为 0。',
  },
];

const STEPS = [
  { n: '01', title: '描述你的品牌', text: '自然语言或官网地址,AI 解析品牌档案,自动建议识别词、产品线别名与竞品清单。' },
  { n: '02', title: '配置监控问题', text: '批量粘贴,自动分为排名词/口碑词并拓写为用户真实问法;分池配额清晰可见。' },
  { n: '03', title: '看排名出报告', text: '5 大引擎分钟级出数:全景矩阵、可见性漏斗、口碑与引用缺口,周报自动生成。' },
];

const PRICING = [
  { name: '免费版', price: '¥0', note: '3 排名词 + 1 口碑词 · 3 引擎', cta: '免费开始', hot: false },
  { name: '入门', price: '¥79', note: '10 题 · 5 引擎 · 周报', cta: '选择入门', hot: false },
  { name: '标准', price: '¥199', note: '38 题 · 5 引擎 · 周/月报', cta: '选择标准', hot: true },
  { name: '专业', price: '¥499', note: '130 题 · 优先队列 · 多品牌', cta: '选择专业', hot: false },
];

/** 官网落地页(匿名访客;原创文案,docs/00 价值主张)。 */
export default function LandingPage() {
  const [logged, setLogged] = useState(false);
  const [brand, setBrand] = useState('');
  useEffect(() => setLogged(!!tokenStore.access), []);

  const startHref = logged ? '/dashboard' : '/login';

  return (
    <div className="min-h-screen bg-white">
      {/* ===== 导航 ===== */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-700 text-white">
              <IconLogo width={18} height={18} />
            </span>
            <span>
              <span className="block text-[15px] font-semibold leading-4 text-white">GeoLens</span>
              <span className="block text-[10px] leading-3.5 text-slate-500">AI 搜索品牌可见性监测</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-slate-300 md:flex">
            <a href="#values" className="transition-colors hover:text-white">产品</a>
            <a href="#how" className="transition-colors hover:text-white">如何工作</a>
            <a href="#pricing" className="transition-colors hover:text-white">定价</a>
          </nav>
          <div className="flex items-center gap-3">
            {logged ? (
              <Link href="/dashboard" className="btn-primary h-9 px-4">
                进入控制台
                <IconArrowRight width={14} height={14} />
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-sm text-slate-300 transition-colors hover:text-white">
                  登录
                </Link>
                <Link href="/login" className="btn-primary h-9 px-4">
                  免费开始
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ===== Hero ===== */}
      <section className="relative overflow-hidden bg-ink-950">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[30rem] w-[30rem] animate-float-slow rounded-full bg-brand-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-52 right-0 h-[34rem] w-[34rem] rounded-full bg-sand/10 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'linear-gradient(rgba(103,232,249,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(103,232,249,.05) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse 90% 70% at 50% 0%, black 40%, transparent 100%)',
          }}
        />

        <div className="relative mx-auto max-w-6xl px-6 pb-24 pt-20 text-center md:pt-28">
          <div className="rise mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-brand-400/20 bg-brand-400/10 px-3.5 py-1.5 text-xs text-brand-200">
            <IconSpark width={13} height={13} />
            每日 5 大引擎中立监测 · 每个数字可回溯
          </div>
          <h1 className="rise mx-auto max-w-3xl text-4xl font-semibold leading-[1.2] tracking-tight text-white md:text-[56px] md:leading-[1.15]">
            当用户问 AI 时,
            <br className="hidden md:block" />
            你的品牌
            <span className="bg-gradient-to-r from-brand-300 via-sand-300 to-brand-200 bg-clip-text text-transparent">
              被推荐了吗?
            </span>
          </h1>
          <p className="rise-1 mx-auto mt-5 max-w-2xl text-[15px] leading-7 text-slate-400 md:text-base">
            GeoLens 用中立账号向主流 AI 引擎批量提问,量化品牌的提及率、推荐位次、
            口碑倾向与引用来源 —— 每一个数字都能回放到原始回答与快照。
          </p>

          {/* 品牌输入框(对齐行业首屏交互) */}
          <div className="rise-2 mx-auto mt-9 max-w-xl">
            <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[.06] p-2 shadow-glow backdrop-blur transition-colors focus-within:border-brand-400/40">
              <input
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (window.location.href = startHref)}
                placeholder='例如:「小米汽车,主打高性能纯电轿车」'
                className="h-11 flex-1 bg-transparent px-3 text-sm text-white placeholder:text-slate-500 focus:outline-none"
              />
              <Link href={startHref} className="btn-primary h-11 shrink-0 px-5">
                免费诊断
                <IconArrowRight width={15} height={15} />
              </Link>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              注册即可用免费版监测 3 个排名词 + 1 个口碑词 · 10 分钟出真实数据
            </p>
          </div>

          {/* 引擎覆盖 */}
          <div className="rise-3 mt-14">
            <p className="text-xs tracking-widest text-slate-600">已覆盖 5 大国产 AI 引擎</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              {ENGINES.map((e) => (
                <span
                  key={e}
                  className="rounded-full border border-white/10 bg-white/[.04] px-4 py-1.5 text-sm text-slate-300 transition-colors hover:border-brand-400/30 hover:text-brand-200"
                >
                  {e}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== 三大价值 ===== */}
      <section id="values" className="mx-auto max-w-6xl px-6 py-24">
        <SectionHead
          eyebrow="为什么是 GeoLens"
          title="看见 · 可信 · 可行动"
          sub="不是又一个看板,而是一套可以拿去汇报、经得起质疑的证据体系。"
        />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {VALUES.map((v, i) => (
            <div key={v.title} className={`card card-hover p-7 rise-${i + 1}`}>
              <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600">
                {v.icon}
              </span>
              <h3 className="text-lg font-semibold text-slate-900">{v.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{v.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== 证据链(深色段) ===== */}
      <section className="relative overflow-hidden bg-ink-950 py-24">
        <div className="pointer-events-none absolute right-0 top-0 h-96 w-96 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="grid items-center gap-14 lg:grid-cols-2">
            <div>
              <p className="text-xs font-medium tracking-widest text-brand-300">证据链,是对抗质疑的根本</p>
              <h2 className="mt-3 text-3xl font-semibold leading-snug tracking-tight text-white md:text-4xl">
                AI 说没说你,
                <br />
                拿证据说话。
              </h2>
              <p className="mt-4 text-[15px] leading-7 text-slate-400">
                「数据被质疑」是这个品类最致命的风险。GeoLens 把可信做成工程:全链路存证、
                口径透明、失败态诚实呈现——这也是我们与同类产品最本质的区别。
              </p>
              <Link href={startHref} className="btn-soft mt-7">
                查看我的品牌可见性
                <IconArrowRight width={14} height={14} />
              </Link>
            </div>
            <div className="space-y-4">
              {EVIDENCE.map((e, i) => (
                <div
                  key={e.title}
                  className={`rise-${i + 1} rounded-xl border border-white/10 bg-white/[.04] p-5 backdrop-blur transition-colors hover:border-brand-400/30`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-500/15 text-brand-300">
                      <IconCheck width={13} height={13} />
                    </span>
                    <h3 className="text-[15px] font-semibold text-slate-100">{e.title}</h3>
                  </div>
                  <p className="mt-2 pl-8.5 text-sm leading-6 text-slate-400" style={{ paddingLeft: '2.125rem' }}>
                    {e.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== 三步流程 ===== */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-24">
        <SectionHead
          eyebrow="如何工作"
          title="10 分钟,看到真实数据"
          sub="从注册到首轮 AI 排名数据,一个上午都不用。"
        />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.n} className={`relative card p-7 rise-${i + 1}`}>
              <span className="metric-num text-3xl font-semibold text-brand-200">{s.n}</span>
              <h3 className="mt-3 text-lg font-semibold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{s.text}</p>
              {i < 2 && (
                <IconArrowRight
                  width={18}
                  height={18}
                  className="absolute -right-3.5 top-1/2 hidden -translate-y-1/2 text-slate-300 md:block"
                />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ===== 定价 ===== */}
      <section id="pricing" className="bg-slate-50 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <SectionHead
            eyebrow="定价"
            title="从免费监测开始"
            sub="所有档位均可监测全部 5 大引擎;超套餐动作按积分计费,每一处明码标价。"
          />
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {PRICING.map((p, i) => (
              <div
                key={p.name}
                className={`relative rounded-2xl border p-6 rise-${(i % 3) + 1} transition-all duration-200 hover:-translate-y-1 ${
                  p.hot
                    ? 'border-brand-500 bg-ink-950 text-white shadow-glow'
                    : 'card bg-white'
                }`}
              >
                {p.hot && (
                  <span className="absolute -top-3 left-6 rounded-full bg-gradient-to-r from-brand-400 to-brand-600 px-2.5 py-0.5 text-[10px] font-medium text-white">
                    最受欢迎
                  </span>
                )}
                <h3 className={`text-sm font-medium ${p.hot ? 'text-brand-300' : 'text-slate-500'}`}>{p.name}</h3>
                <p className="mt-2">
                  <span className="metric-num text-3xl font-semibold">{p.price}</span>
                  <span className={`text-sm ${p.hot ? 'text-slate-400' : 'text-slate-400'}`}>/月</span>
                </p>
                <p className={`mt-2 text-xs leading-5 ${p.hot ? 'text-slate-400' : 'text-slate-500'}`}>{p.note}</p>
                <Link
                  href={startHref}
                  className={`mt-5 w-full ${p.hot ? 'btn-primary' : 'btn-ghost'}`}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-400">
            年付享折扣 · 单次快速体检按积分计费(网页端 2 积分/题·引擎)· 全部档位口径一致
          </p>
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section className="relative overflow-hidden bg-ink-950 py-20 text-center">
        <div className="pointer-events-none absolute left-1/2 top-0 h-72 w-[40rem] -translate-x-1/2 rounded-full bg-brand-500/15 blur-3xl" />
        <div className="relative mx-auto max-w-2xl px-6">
          <h2 className="text-3xl font-semibold tracking-tight text-white">
            别等 AI 搜索把你遗忘。
          </h2>
          <p className="mt-3 text-[15px] text-slate-400">
            免费版立刻开始监测;数据 7 天内均可回溯到原始回答。
          </p>
          <Link href={startHref} className="btn-primary mt-8 h-12 px-8 text-[15px]">
            免费开始监测
            <IconArrowRight width={16} height={16} />
          </Link>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="border-t border-slate-200 bg-white py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-400 to-brand-700 text-white">
              <IconLogo width={13} height={13} />
            </span>
            <span>© 2026 GeoLens · AI 搜索品牌可见性监测</span>
          </div>
          <div className="flex items-center gap-5">
            <span className="inline-flex items-center gap-1">
              <IconCite width={13} height={13} />
              数据口径与方法论文档
            </span>
            <span>中立监测 · 不干预排名 · 过程可审计</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-medium tracking-widest text-brand-600">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">{title}</h2>
      <p className="mt-4 text-[15px] leading-7 text-slate-500">{sub}</p>
    </div>
  );
}
