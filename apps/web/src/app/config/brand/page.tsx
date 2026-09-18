'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { useToast } from '@/components/toast';
import { PageHeader, Skeleton } from '@/components/ui';

/**
 * 品牌资产(docs/01 IA ④ 合并版):品牌资料 + 识别口径 一体化管理。
 * 名称是识别匹配的本品词,改名由后端同步本品识别口径并落口径版本;
 * 描述补充新卖点/竞品后,直接在下方口径区确认与补充。
 */

interface BrandRow {
  id: number;
  name: string;
  industry: string | null;
  website: string | null;
  intro: string | null;
}

interface RecognitionRow {
  id: number;
  kind: 'self' | 'competitor';
  name: string;
  aliases: string[];
  note: string | null;
  confirmed: boolean;
}

export default function BrandAssetPage() {
  const brandId = useBrandId();
  const toast = useToast();
  const queryClient = useQueryClient();

  // ===== 品牌资料 =====
  const { data: brands, isLoading: brandLoading } = useQuery({
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

  // ===== 识别口径 =====
  const [entryName, setEntryName] = useState('');
  const [entryAliases, setEntryAliases] = useState('');
  const [entryKind, setEntryKind] = useState<'self' | 'competitor'>('competitor');
  const rows = useQuery({
    queryKey: ['recognition', brandId],
    queryFn: () => api<RecognitionRow[]>(`/brands/${brandId}/recognition`),
    enabled: !!brandId,
  });
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['recognition'] });
    void queryClient.invalidateQueries({ queryKey: ['brands'] });
  };

  const saveProfile = async () => {
    if (!brand || !form) return;
    if (!form.name.trim()) {
      toast('品牌名不能为空', 'err');
      return;
    }
    setSaving(true);
    try {
      await api(`/brands/${brand.id}`, { method: 'PATCH', json: form });
      refreshAll();
      toast('品牌资料已保存');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const saveEntry = useMutation({
    mutationFn: () =>
      api(`/brands/${brandId}/recognition`, {
        method: 'POST',
        json: { kind: entryKind, name: entryName, aliases: entryAliases.split(/[,、]/).map((s) => s.trim()).filter(Boolean) },
      }),
    onSuccess: () => {
      toast('识别口径已保存,版本快照已记录');
      setEntryName('');
      setEntryAliases('');
      refreshAll();
    },
  });

  const setConfirmed = useMutation({
    mutationFn: ({ entryId, confirmed }: { entryId: number; confirmed: boolean }) =>
      api(`/brands/${brandId}/recognition/${entryId}`, { method: 'PATCH', json: { confirmed } }),
    onSuccess: () => {
      toast('已更新,版本快照已记录');
      refreshAll();
    },
  });

  const removeEntry = useMutation({
    mutationFn: (entryId: number) => api(`/brands/${brandId}/recognition/${entryId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('已删除');
      refreshAll();
    },
  });

  if (brandLoading || !form) return <Skeleton />;

  const dirty =
    !!brand &&
    (form.name !== brand.name ||
      form.industry !== (brand.industry ?? '') ||
      form.website !== (brand.website ?? '') ||
      form.intro !== (brand.intro ?? ''));
  const self = rows.data?.find((r) => r.kind === 'self');
  const competitors = rows.data?.filter((r) => r.kind === 'competitor') ?? [];
  const pending = competitors.filter((c) => !c.confirmed).length;

  return (
    <>
      <PageHeader
        title="品牌资产"
        desc="品牌资料与识别口径一体管理:这里是采集与排名口径的源头,补充越完整,识别越准。"
        actions={
          <button className="btn-primary disabled:opacity-40" disabled={saving || !dirty} onClick={() => void saveProfile()}>
            {saving ? '保存中…' : '保存资料'}
          </button>
        }
      />

      {/* ===== 品牌资料 ===== */}
      <section className="card rise mt-4 space-y-4 p-6">
        <h2 className="text-sm font-medium text-slate-900">品牌资料</h2>
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
              名称是识别匹配的本品词,改名会自动同步下方「本品识别口径」并落版本快照
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
            placeholder="品牌定位、产品线、核心卖点、目标人群……建议写清主要竞品名单与各自叫法(别名),识别准确度会明显提升"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6"
          />
          <span className="mt-1 flex justify-between text-[11px] text-slate-400">
            <span>补充竞品/别名后,在下方「识别口径」区确认即可生效</span>
            <span className="metric-num">{form.intro.length}/2000</span>
          </span>
        </label>
      </section>

      {/* ===== 识别口径 ===== */}
      <section className="card rise-1 mt-4 p-6">
        <h2 className="text-sm font-medium text-slate-900">本品识别口径</h2>
        {self ? (
          <p className="mt-2 text-sm">
            识别词:<b>{self.name}</b>
            <span className="ml-3 text-slate-500">别名:{self.aliases.length > 0 ? self.aliases.join('、') : '(无)'}</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-400">尚未配置</p>
        )}
      </section>

      <section className="card mt-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-900">竞品清单({competitors.length})</h2>
          {pending > 0 && (
            <span className="rounded bg-warn-50 px-2 py-0.5 text-xs text-warn">{pending} 条待确认</span>
          )}
        </div>
        <p className="mb-3 mt-1 text-xs text-slate-400">
          AI 建议的竞品需确认后才会参与识别;误识别的条目(如把车型词当成竞品)直接删除。
        </p>
        <ul className="space-y-2 text-sm">
          {competitors.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <b>{c.name}</b>
              <span className="text-slate-500">{c.aliases.length > 0 ? `别名:${c.aliases.join('、')}` : ''}</span>
              {!c.confirmed && <span className="rounded bg-warn-50 px-1.5 text-xs text-warn">待确认</span>}
              <span className="ml-auto flex items-center gap-2">
                {!c.confirmed && (
                  <button
                    className="h-7 rounded bg-brand px-2.5 text-xs text-white disabled:opacity-50"
                    disabled={setConfirmed.isPending}
                    onClick={() => setConfirmed.mutate({ entryId: c.id, confirmed: true })}
                  >
                    确认
                  </button>
                )}
                <button
                  className="h-7 px-2 text-xs text-slate-500 hover:text-slate-800"
                  onClick={() => removeEntry.mutate(c.id)}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
          {competitors.length === 0 && <li className="text-slate-400">暂无竞品条目</li>}
        </ul>
      </section>

      <section className="card rise-2 mt-4 p-6">
        <h2 className="mb-3 text-sm font-medium text-slate-900">新增 / 更新口径</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded border px-2 py-1.5 text-sm" value={entryKind} onChange={(e) => setEntryKind(e.target.value as never)}>
            <option value="competitor">竞品</option>
            <option value="self">本品别名补充</option>
          </select>
          <input className="w-44 rounded border px-2 py-1.5 text-sm" placeholder="名称" value={entryName} onChange={(e) => setEntryName(e.target.value)} />
          <input
            className="w-96 rounded border px-2 py-1.5 text-sm"
            placeholder="别名(逗号分隔,如:问界 M9, M9, 智界)"
            value={entryAliases}
            onChange={(e) => setEntryAliases(e.target.value)}
          />
          <button
            className="rounded bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={saveEntry.isPending || entryName.trim().length < 2}
            onClick={() => saveEntry.mutate()}
          >
            保存
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-400">保存即生效并落口径版本快照,历史报告按当时口径复现。</p>
      </section>
    </>
  );
}
