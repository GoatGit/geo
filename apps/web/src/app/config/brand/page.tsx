'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, useBrandId } from '@/lib/queries';
import { useToast } from '@/components/toast';
import { PageHeader, Skeleton } from '@/components/ui';

/**
 * 品牌资料(品牌资产栏目):建号后可继续修改/补充品牌信息。
 * 名称是识别匹配的本品词,改名由后端同步本品识别口径并落口径版本;
 * 描述补充新卖点后,可到「识别口径」页确认/补充竞品与别名。
 */

interface BrandRow {
  id: number;
  name: string;
  industry: string | null;
  website: string | null;
  intro: string | null;
}

export default function BrandProfilePage() {
  const brandId = useBrandId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: brands, isLoading } = useQuery({
    queryKey: ['brands'],
    queryFn: () => api<BrandRow[]>('/brands'),
    enabled: !!brandId,
  });
  const brand = (brands ?? []).find((b) => b.id === brandId) ?? brands?.[0];

  const [form, setForm] = useState<{ name: string; industry: string; website: string; intro: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (brand) {
      setForm({
        name: brand.name,
        industry: brand.industry ?? '',
        website: brand.website ?? '',
        intro: brand.intro ?? '',
      });
    }
  }, [brand?.id, brand?.name, brand?.intro, brand?.industry, brand?.website]);

  if (isLoading || !form) return <Skeleton />;

  const save = async () => {
    if (!brand || !form) return;
    if (!form.name.trim()) {
      toast('品牌名不能为空', 'err');
      return;
    }
    setSaving(true);
    try {
      await api(`/brands/${brand.id}`, { method: 'PATCH', json: form });
      void queryClient.invalidateQueries({ queryKey: ['brands'] });
      toast('品牌资料已保存');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!brand &&
    (form.name !== brand.name ||
      form.industry !== (brand.industry ?? '') ||
      form.website !== (brand.website ?? '') ||
      form.intro !== (brand.intro ?? ''));

  return (
    <>
      <PageHeader
        title="品牌资料"
        desc="品牌的基础信息与描述;这里是采集与口径的源头,补充越完整,AI 建议与识别越准。"
        actions={
          <button className="btn-primary disabled:opacity-40" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? '保存中…' : '保存修改'}
          </button>
        }
      />

      <section className="card rise mt-4 space-y-4 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-xs font-medium text-slate-600">
            品牌名 *
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={60}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-[11px] leading-4 text-slate-400">
              名称是识别匹配的本品词,改名会自动同步「识别口径」并落版本快照
            </span>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            行业
            <input
              value={form.industry}
              onChange={(e) => setForm({ ...form, industry: e.target.value })}
              maxLength={40}
              placeholder="如:新能源汽车"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block text-xs font-medium text-slate-600">
          官网
          <input
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            maxLength={200}
            placeholder="https://…(用于自有信源识别)"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-xs font-medium text-slate-600">
          品牌描述 / 品牌资料
          <textarea
            value={form.intro}
            onChange={(e) => setForm({ ...form, intro: e.target.value })}
            rows={8}
            maxLength={2000}
            placeholder="品牌定位、产品线、核心卖点、目标人群、主要竞品……可以随时补充,作为品牌资产沉淀"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6"
          />
          <span className="mt-1 flex justify-between text-[11px] text-slate-400">
            <span>描述更新后,建议到「识别口径」页复核竞品与别名建议</span>
            <span className="metric-num">{form.intro.length}/2000</span>
          </span>
        </label>
      </section>

      <section className="card rise-1 mt-4 flex flex-wrap items-center justify-between gap-3 p-5 text-xs text-slate-500">
        <span>识别口径(本品别名/竞品词)决定 AI 回答里"提到谁算谁",是排名与口碑口径的基石。</span>
        <Link href="/config/recognition" className="btn-soft h-8 px-3">
          前往识别口径
        </Link>
      </section>
    </>
  );
}
