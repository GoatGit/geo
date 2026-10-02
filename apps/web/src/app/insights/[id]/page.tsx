'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { InsightBlocks } from '@/components/insight-charts';
import { InsightFactsDrawer } from '@/components/insight-facts-drawer';
import { api, apiDownload } from '@/lib/api';
import type { InsightDetailDto, InsightDrill } from '@geo/shared';

/**
 * 行业洞察报告详情(docs/01 §3.10 扩展):印刷风只读页;
 * 已发布报告对全员公开(官网引流),草稿 404。头部口径与样张一致:
 * 命中高 ≠ 评价好,量的是被 AI 主动提及。
 */
export default function InsightDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const query = useQuery({
    queryKey: ['insight', id],
    // 登录用户带 token(可读本人/订阅行业的草稿);匿名访客不带(仅已发布报告公开可见)
    queryFn: () =>
      api<InsightDetailDto>(`/insights/${id}`, {
        auth: typeof window !== 'undefined' && !!localStorage.getItem('geo.accessToken') ? undefined : false,
      }),
    enabled: Number.isFinite(id),
  });

  // hooks 必须在条件 return 之前:本页为公开营销页,顺序违规会让数据到达后的
  // 重渲染多执行一个 hook,React 直接抛错白屏
  const title = query.data?.title;
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · 格尺GEO`;
    return () => {
      document.title = '格尺GEO · AI 搜索品牌可见性监测';
    };
  }, [title]);

  // 1.5 数字下钻:图表数字点击 → 事实明细抽屉(排行条目/热力格子/桑基标签)
  const [drill, setDrill] = useState<InsightDrill | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const toast = useToast();

  if (query.isLoading) return <Skeleton />;
  if (query.isError) {
    // 网络抖动/服务故障 ≠ 报告不存在:分开呈现,404 才是"不存在"
    const notFound = (query.error as { code?: number }).code === 404;
    return notFound ? (
      <EmptyState title="报告不存在" text="该洞察报告不存在或尚未发布。" action={<Link href="/" className="btn-ghost">返回官网</Link>} />
    ) : (
      <EmptyState
        title="加载失败"
        text={`${(query.error as Error).message} —— 请重试。`}
        action={
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => void query.refetch()}>重试</button>
            <Link href="/" className="btn-ghost">返回官网</Link>
          </div>
        }
      />
    );
  }
  if (!query.data) {
    return <EmptyState title="报告不存在" text="该洞察报告不存在或尚未发布。" action={<Link href="/" className="btn-ghost">返回官网</Link>} />;
  }
  const d = query.data;
  const cover = d.cover ?? {};

  return (
    <div className="min-h-screen bg-slate-50">
      <article className="mx-auto max-w-4xl px-6 py-10">
        {/* 报告头(印刷风页眉) */}
        <header className="rise">
          <p className="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wide text-slate-500">
            <Link href="/" className="text-brand-700 hover:underline">格尺GEO</Link>
            <span>·</span>
            <span>{d.issue || '行业洞察'}</span>
            <span>·</span>
            <span>{d.industry} AI 可见度</span>
            {d.featured && <Badge label="官网精选" tone="brand" />}
            <span className="ml-auto flex items-center gap-2">
              <button className="btn-soft h-8 px-3 text-xs" onClick={() => router.back()} title="返回上一页">
                ← 返回
              </button>
              {/* 带 token 的 blob 下载:裸 <a download> 不带 Authorization,草稿报告会被
                  404 的 JSON 错误体当作文件存下来(实测 insight-5.json) */}
              <button
                className="btn-soft h-8 px-3 text-xs disabled:opacity-50"
                disabled={pdfBusy}
                title="下载 PDF 版报告"
                onClick={async () => {
                  setPdfBusy(true);
                  try {
                    const hasToken = typeof window !== 'undefined' && !!localStorage.getItem('geo.accessToken');
                    // 匿名访客(已发布报告)走直链;登录用户走带 token 的 blob 下载
                    if (!hasToken) {
                      window.open(`/api/insights/${d.id}/pdf`, '_blank');
                      return;
                    }
                    await apiDownload(`/insights/${d.id}/pdf`, `格尺GEO-行业洞察-${d.industry}-${d.issue || d.id}.pdf`);
                  } catch (e) {
                    toast((e as Error).message, 'err');
                  } finally {
                    setPdfBusy(false);
                  }
                }}
              >
                {pdfBusy ? '生成中…' : '下载 PDF'}
              </button>
            </span>
          </p>
          <h1 className="mt-3 text-[30px] font-bold leading-tight tracking-tight text-slate-900">{d.title}</h1>
          <div className="mt-3 h-1 rounded bg-slate-900/90" />
          {d.summary && <p className="mt-4 text-sm leading-6 text-slate-600">{d.summary}</p>}
          {(cover.brands || cover.questions || cover.answers) && (
            <p className="metric-num mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-slate-500">
              {cover.brands ? <span>{cover.brands} 个品牌</span> : null}
              {cover.questions ? <span>{cover.questions} 道抢答题</span> : null}
              {cover.answers ? <span>{cover.answers} 条回答</span> : null}
              {cover.testedAt ? <span>实测 {cover.testedAt}</span> : null}
              {cover.headline ? <span className="font-semibold text-slate-700">{cover.headline}</span> : null}
            </p>
          )}
        </header>

        {/* 图表块(可点击的数字带下钻:命中/引用事实明细) */}
        <section className="mt-8">
          <InsightBlocks blocks={d.blocks} onDrill={setDrill} />
        </section>

        {/* 口径页脚(全报告唯一口径出处;各图表不再重复) */}
        <footer className="mt-8 border-t border-slate-200 pt-4 text-[11px] leading-5 text-slate-400">
          <p>
            口径说明:提及率 = 提及该品牌的回答数 ÷ 有效回答数;Top3 率与首位率的分母 = 有效且有名次;
            采集失败与配额拦截不计入任何分母。有效回答指 AI 返回了实质内容的作答。
          </p>
          <p className="mt-1">口径提醒:命中率高 ≠ 评价好,本报告度量的是「被 AI 主动提及」;监测题目不含品牌名,避免提示偏差。</p>
          <p className="mt-1">数字可回溯:点击品牌条目、热力格子或桑基标签,可查看对应的原始回答摘录与引用来源明细。</p>
          <p className="mt-1">
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer" className="hover:text-slate-600">
              京ICP备2024074563号-9
            </a>
          </p>
          <p className="mt-1 flex items-center justify-between">
            <span>数据来源:格尺GEO 实测(6 平台抢答)</span>
            <span>{d.publishedAt ? new Date(d.publishedAt).toLocaleDateString('zh-CN') : ''}</span>
          </p>
        </footer>

        <div className="mt-8 text-center">
          <Link href={d.industry ? '/' : '/dashboard'} className="btn-ghost">了解更多行业洞察</Link>
        </div>
      </article>

      {drill && <InsightFactsDrawer insightId={id} drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
