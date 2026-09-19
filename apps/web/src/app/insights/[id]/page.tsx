'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState, Skeleton } from '@/components/ui';
import { InsightBlocks } from '@/components/insight-charts';
import { api } from '@/lib/api';
import type { InsightDetailDto } from '@geo/shared';

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
    queryFn: () => api<InsightDetailDto>(`/insights/${id}`, { auth: false }),
    enabled: Number.isFinite(id),
  });

  // hooks 必须在条件 return 之前:本页为公开营销页,顺序违规会让数据到达后的
  // 重渲染多执行一个 hook,React 直接抛错白屏
  const title = query.data?.title;
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · 青柠GEO`;
    return () => {
      document.title = '青柠GEO · AI 搜索品牌可见性监测';
    };
  }, [title]);

  if (query.isLoading) return <Skeleton />;
  if (query.error || !query.data) {
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
            <Link href="/" className="text-brand-700 hover:underline">青柠GEO</Link>
            <span>·</span>
            <span>{d.issue || '行业洞察'}</span>
            <span>·</span>
            <span>{d.industry} AI 可见度</span>
            {d.featured && <Badge label="官网精选" tone="brand" />}
            <span className="ml-auto flex items-center gap-2">
              <button className="btn-soft h-8 px-3 text-xs" onClick={() => router.back()} title="返回上一页">
                ← 返回
              </button>
              <a
                href={`/api/insights/${d.id}/pdf`}
                className="btn-soft h-8 px-3 text-xs"
                download
                title="下载 PDF 版报告"
              >
                下载 PDF
              </a>
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

        {/* 图表块 */}
        <section className="mt-8">
          <InsightBlocks blocks={d.blocks} />
        </section>

        {/* 口径页脚(全报告唯一口径出处;各图表不再重复) */}
        <footer className="mt-8 border-t border-slate-200 pt-4 text-[11px] leading-5 text-slate-400">
          <p>
            口径说明:提及率 = 提及该品牌的回答数 ÷ 有效回答数;Top3 率与首位率的分母 = 有效且有名次;
            采集失败与配额拦截不计入任何分母。有效回答指 AI 返回了实质内容的作答。
          </p>
          <p className="mt-1">口径提醒:命中率高 ≠ 评价好,本报告度量的是「被 AI 主动提及」;监测题目不含品牌名,避免提示偏差。</p>
          <p className="mt-1">
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer" className="hover:text-slate-600">
              京ICP备2024074563号-9
            </a>
          </p>
          <p className="mt-1 flex items-center justify-between">
            <span>数据来源:青柠GEO 实测(6 平台抢答)</span>
            <span>{d.publishedAt ? new Date(d.publishedAt).toLocaleDateString('zh-CN') : ''}</span>
          </p>
        </footer>

        <div className="mt-8 text-center">
          <Link href={d.industry ? '/' : '/dashboard'} className="btn-ghost">了解更多行业洞察</Link>
        </div>
      </article>
    </div>
  );
}
