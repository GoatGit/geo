'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { useToast } from '@/components/toast';
import { Skeleton } from '@/components/ui';

/**
 * 品牌资产(docs/01 IA ④ 对标竞品品牌库重构):
 * 品牌档案 Hero 卡(认证徽章/行业+官网 chip/AI 挖掘)+ 资料库(文本/链接)+ 识别口径一体管理。
 * 识别口径是采集与排名口径的源头,保存落版本快照,历史报告按当时口径复现。
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

interface MaterialRow {
  id: number;
  kind: 'text' | 'url';
  title: string;
  content: string;
  source: 'manual' | 'dig';
  byteLen: number;
  createdAt: string;
}

const KIND_LABEL: Record<MaterialRow['kind'], string> = { text: '📝 文本', url: '🔗 链接' };

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
  const [editing, setEditing] = useState(false);
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

  // ===== 资料库 =====
  const materials = useQuery({
    queryKey: ['brand-materials'],
    queryFn: () => api<MaterialRow[]>(`/brands/${brandId}/materials`),
    enabled: !!brandId,
  });
  const [matKind, setMatKind] = useState<'text' | 'url'>('text');
  const [matTitle, setMatTitle] = useState('');
  const [matContent, setMatContent] = useState('');
  const [matFilter, setMatFilter] = useState<'all' | 'text' | 'url'>('all');
  const addMaterial = useMutation({
    mutationFn: () =>
      api(`/brands/${brandId}/materials`, { method: 'POST', json: { kind: matKind, title: matTitle, content: matContent } }),
    onSuccess: () => {
      toast('资料已添加');
      setMatTitle('');
      setMatContent('');
      void queryClient.invalidateQueries({ queryKey: ['brand-materials'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });
  const removeMaterial = useMutation({
    mutationFn: (mid: number) => api(`/brands/materials/${mid}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('已删除');
      void queryClient.invalidateQueries({ queryKey: ['brand-materials'] });
    },
  });
  const shownMaterials = useMemo(
    () => (materials.data ?? []).filter((m) => matFilter === 'all' || m.kind === matFilter),
    [materials.data, matFilter],
  );

  // ===== AI 品牌挖掘(后台执行 + 轮询:LLM 生成 20-40s,同步请求会被网关超时切断) =====
  const [digging, setDigging] = useState(false);
  const knownDigIds = useMemo(() => new Set((materials.data ?? []).filter((m) => m.source === 'dig').map((m) => m.id)), [materials.data]);
  const dig = useMutation({
    mutationFn: async () => {
      await api(`/brands/${brandId}/dig`, { method: 'POST' });
      // 轮询:挖掘完成后 brand-materials 会多出一条 dig 资料
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const st = await api<{ running: boolean }>(`/brands/${brandId}/dig/status`);
          if (!st.running) break;
        } catch {
          break;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['brand-materials'] });
      await queryClient.invalidateQueries({ queryKey: ['brands'] });
    },
    onSuccess: () => {
      setDigging(false);
      const fresh = (queryClient.getQueryData<MaterialRow[]>(['brand-materials']) ?? []).filter(
        (m) => m.source === 'dig' && !knownDigIds.has(m.id),
      );
      if (fresh.length > 0) {
        toast('AI 品牌挖掘完成:画像已写入描述,竞品建议在下方确认');
        void queryClient.refetchQueries({ queryKey: ['brand-materials'] });
        void queryClient.refetchQueries({ queryKey: ['brands'] });
      } else {
        toast('本轮挖掘未产出,请稍后重试', 'err');
      }
    },
    onError: (e) => {
      setDigging(false);
      toast((e as Error).message, 'err');
    },
  });
  const digPending = digging || dig.isPending;

  // ===== 保存资料 =====
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
      setEditing(false);
      toast('品牌资料已保存');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

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
  const certBadge = Boolean(brand?.website && (brand?.intro ?? '').length >= 50);
  const counts = {
    all: materials.data?.length ?? 0,
    text: (materials.data ?? []).filter((m) => m.kind === 'text').length,
    url: (materials.data ?? []).filter((m) => m.kind === 'url').length,
  };

  return (
    <>
      {/* ===== 品牌档案 Hero 卡 ===== */}
      <section className="rise mt-1 overflow-hidden rounded-2xl border border-brand/15 bg-gradient-to-br from-brand-50 via-[#efe9ff] to-[#fdf2fb] p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-[#b8a9ff] text-2xl font-extrabold text-white shadow-lg">
            {form.name.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-wide text-slate-900">
              {brand?.name ?? form.name}
              {certBadge && (
                <span className="rounded-full border border-good/30 bg-good-50 px-2 py-0.5 text-[11px] font-bold text-good">
                  ✓ 已认证品牌
                </span>
              )}
            </div>
            <div className="my-2 flex flex-wrap gap-1.5">
              {form.industry && (
                <span className="rounded-full border border-brand/15 bg-white/80 px-2.5 py-0.5 text-[11px] text-slate-700">
                  {form.industry}
                </span>
              )}
              {form.website && (
                <span className="rounded-full border border-brand/15 bg-white/80 px-2.5 py-0.5 text-[11px] text-slate-700">
                  {form.website.replace(/^https?:\/\//, '')}
                </span>
              )}
              <span className="rounded-full border border-brand/15 bg-white/80 px-2.5 py-0.5 text-[11px] text-slate-700">
                竞品 {competitors.length}
              </span>
              <span className="rounded-full border border-brand/15 bg-white/80 px-2.5 py-0.5 text-[11px] text-slate-700">
                资料 {counts.all}
              </span>
            </div>
            {!editing && (
              <p className="max-w-[660px] whitespace-pre-wrap text-[12.5px] leading-6 text-slate-600">
                {form.intro || '尚无品牌描述——点击「AI 品牌挖掘」自动生成结构化画像,或「编辑档案」手动填写。'}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 sm:ml-auto">
            <button
              className="btn-primary disabled:opacity-50"
              disabled={digPending}
              onClick={() => dig.mutate()}
              title="基于品牌名/行业/官网/描述,LLM 生成结构化品牌画像与竞品建议"
            >
              {digPending ? "挖掘中…(约 30-60s)" : "✦ AI 品牌挖掘"}
            </button>
            <button
              className="rounded-lg border bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-slate-700 transition-colors hover:border-brand/40 hover:text-brand"
              onClick={() => document.getElementById('recognition-section')?.scrollIntoView({ behavior: 'smooth' })}
              title="维护识别口径,决定 AI 回答里哪些说法算作你"
            >
              识别口径管理
            </button>
            <button
              className="rounded-lg border bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-slate-700 transition-colors hover:border-brand/40 hover:text-brand"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? '收起编辑' : '编辑档案'}
            </button>
          </div>
        </div>
        {digPending && (
          <p className="mt-3 rounded bg-white/70 px-3 py-1.5 text-xs text-slate-500">
            正在基于品牌名/行业/官网/现有描述生成结构化画像与竞品建议……
          </p>
        )}
      </section>

      {/* ===== 编辑档案(表单) ===== */}
      {editing && (
        <section className="card mt-4 space-y-4 p-6">
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
              placeholder="品牌定位、产品线、核心卖点、目标人群……建议写清主要竞品名单与各自叫法(别名),识别准确度会明显提升"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6"
            />
            <span className="mt-1 flex justify-between text-[11px] text-slate-400">
              <span>补充竞品/别名后,在下方「识别口径」区确认即可生效</span>
              <span className="metric-num">{form.intro.length}/2000</span>
            </span>
          </label>
          <button className="btn-primary disabled:opacity-40" disabled={saving || !dirty} onClick={() => void saveProfile()}>
            {saving ? '保存中…' : '保存资料'}
          </button>
        </section>
      )}

      {/* ===== 资料库 ===== */}
      <section className="card mt-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-slate-900">品牌资料库</h2>
            <p className="mt-1 text-xs text-slate-400">品牌档案与参考资料 · 后续写稿、问答、洞察分析时 AI 自动调用</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-slate-200">
            {(['text', 'url'] as const).map((k) => (
              <button
                key={k}
                className={`px-3 py-1.5 text-xs font-medium ${matKind === k ? 'bg-brand-50 text-brand-700' : 'bg-white text-slate-500'}`}
                onClick={() => setMatKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <input
            className="w-48 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
            placeholder="资料标题"
            value={matTitle}
            onChange={(e) => setMatTitle(e.target.value)}
          />
          {matKind === 'url' ? (
            <input
              className="w-72 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
              placeholder="https://…(链接地址)"
              value={matContent}
              onChange={(e) => setMatContent(e.target.value)}
            />
          ) : (
            <input
              className="w-72 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
              placeholder="粘贴文本内容(品牌口碑、卖点、测评……)"
              value={matContent}
              onChange={(e) => setMatContent(e.target.value)}
            />
          )}
          <button
            className="rounded-lg bg-brand px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            disabled={addMaterial.isPending || matTitle.trim().length < 2 || matContent.trim().length < 1}
            onClick={() => addMaterial.mutate()}
          >
            添加资料
          </button>
        </div>

        <div className="mt-4 flex items-center gap-1.5">
          {(
            [
              ['all', `全部 ${counts.all}`],
              ['text', `📝 文本 ${counts.text}`],
              ['url', `🔗 链接 ${counts.url}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                matFilter === k ? 'border border-brand/20 bg-brand-50 text-brand-700' : 'text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => setMatFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <ul className="mt-3 space-y-2">
          {shownMaterials.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <span className="font-medium text-slate-800">{m.title}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                {m.source === 'dig' ? '品牌挖掘' : '手动'}
              </span>
              <span className="text-xs text-slate-400">{KIND_LABEL[m.kind]}</span>
              <span className="ml-auto metric-num text-xs text-slate-400">
                {m.kind === 'text' ? `${m.byteLen} 字` : ''}
              </span>
              <button
                className="h-7 px-2 text-xs text-slate-400 hover:text-slate-800"
                onClick={() => removeMaterial.mutate(m.id)}
              >
                删除
              </button>
            </li>
          ))}
          {shownMaterials.length === 0 && (
            <li className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
              还没有资料——「AI 品牌挖掘」会自动归档品牌画像,也可以手动添加文本/链接
            </li>
          )}
        </ul>
      </section>

      {/* ===== 识别口径 ===== */}
      <section id="recognition-section" className="card rise-1 mt-4 p-6">
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
