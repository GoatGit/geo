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
  const [form, setForm] = useState<{ name: string; industry: string; website: string; intro: string; selfAliases: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (brand) {
      setForm({
        name: brand.name,
        industry: brand.industry ?? '',
        website: brand.website ?? '',
        intro: brand.intro ?? '',
        selfAliases: '',
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
  const [matAdding, setMatAdding] = useState(false);
  const [matFilter, setMatFilter] = useState<'all' | 'text' | 'url'>('all');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const addMaterial = useMutation({
    mutationFn: () =>
      api(`/brands/${brandId}/materials`, { method: 'POST', json: { kind: matKind, title: matTitle, content: matContent } }),
    onSuccess: () => {
      toast('资料已添加');
      setMatAdding(false);
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

  // ===== 保存资料(品牌档案 + 本品别名一并落库:别名走识别口径 self 条目) =====
  const saveProfile = async () => {
    if (!brand || !form) return;
    if (!form.name.trim()) {
      toast('品牌名不能为空', 'err');
      return;
    }
    setSaving(true);
    try {
      await api(`/brands/${brand.id}`, { method: 'PATCH', json: { ...form, selfAliases: undefined } });
      // 本品别名:档案表单与识别口径同源保存(改名由后端同步 self 条目名称)
      const aliases = form.selfAliases.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
      if (selfEntry) {
        await api(`/brands/${brand.id}/recognition/${selfEntry.id}`, {
          method: 'PATCH',
          json: { aliases },
        });
      } else {
        await api(`/brands/${brand.id}/recognition`, {
          method: 'POST',
          json: { kind: 'self', name: form.name.trim(), aliases },
        });
      }
      refreshAll();
      setEditing(false);
      toast('品牌资料已保存(含本品别名),版本快照已记录');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  // ===== 识别口径(竞品清单增/改/删 + 本品别名同源) =====
  const rows = useQuery({
    queryKey: ['recognition', brandId],
    queryFn: () => api<RecognitionRow[]>(`/brands/${brandId}/recognition`),
    enabled: !!brandId,
  });
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['recognition'] });
    void queryClient.invalidateQueries({ queryKey: ['brands'] });
  };
  const selfEntry = rows.data?.find((r) => r.kind === 'self');
  const selfAliasesText = selfEntry?.aliases.join('、') ?? '';

  // 本品别名随识别口径数据回填表单(仅在未编辑时同步,避免覆盖输入)
  useEffect(() => {
    if (!editing) setForm((f) => (f ? { ...f, selfAliases: selfAliasesText } : f));
  }, [selfAliasesText, editing]);

  const updateEntry = useMutation({
    mutationFn: ({ entryId, name, aliases }: { entryId: number; name?: string; aliases?: string[] }) =>
      api(`/brands/${brandId}/recognition/${entryId}`, { method: 'PATCH', json: { name, aliases } }),
    onSuccess: () => {
      toast('已保存,版本快照已记录');
      refreshAll();
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });

  const addCompetitor = useMutation({
    mutationFn: ({ name, aliases }: { name: string; aliases: string[] }) =>
      api(`/brands/${brandId}/recognition`, { method: 'POST', json: { kind: 'competitor', name, aliases } }),
    onSuccess: () => {
      toast('竞品已添加,版本快照已记录');
      setAdding(false);
      setNewName('');
      setNewAliases('');
      refreshAll();
    },
    onError: (e) => toast((e as Error).message, 'err'),
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

  // 竞品行内编辑状态
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editAliases, setEditAliases] = useState('');
  const startEdit = (c: RecognitionRow) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditAliases(c.aliases.join(', '));
  };
  const saveEdit = () => {
    if (editingId == null || !editName.trim()) return;
    updateEntry.mutate({
      entryId: editingId,
      name: editName.trim(),
      aliases: editAliases.split(/[,、]/).map((s) => s.trim()).filter(Boolean),
    });
    setEditingId(null);
  };
  // 新增竞品
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAliases, setNewAliases] = useState('');

  if (brandLoading || !form) return <Skeleton />;

  const dirty =
    !!brand &&
    (form.name !== brand.name ||
      form.industry !== (brand.industry ?? '') ||
      form.website !== (brand.website ?? '') ||
      form.intro !== (brand.intro ?? '') ||
      form.selfAliases !== selfAliasesText);
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
            本品别名(识别口径)
            <input
              value={form.selfAliases}
              onChange={(e) => setForm({ ...form, selfAliases: e.target.value })}
              placeholder="逗号分隔,如:理想, LiXiang, 理想汽车"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-[11px] leading-4 text-slate-400">
              AI 回答里出现这些叫法,都会识别为本品牌并计入提及率
            </span>
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
              <span>补充竞品叫法后,在下方「竞品清单」区添加即可生效</span>
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
          <button
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            disabled={matAdding}
            onClick={() => {
              setMatAdding(true);
              setMatTitle('');
              setMatContent('');
            }}
          >
            + 添加资料
          </button>
        </div>

        {matAdding && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand-50/50 p-2.5">
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
              autoFocus
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
              添加
            </button>
            <button className="h-7 px-2 text-xs text-slate-500 hover:text-slate-800" onClick={() => setMatAdding(false)}>
              取消
            </button>
          </div>
        )}

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
            <li key={m.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <button
                className="flex w-full items-center gap-3 text-left"
                onClick={() => setExpanded((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                title="点击查看内容"
              >
                <span className={`text-[10px] text-slate-400 ${expanded[m.id] ? 'rotate-90' : ''} transition-transform`}>▶</span>
                <span className="font-medium text-slate-800">{m.title}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                  {m.source === 'dig' ? '品牌挖掘' : '手动'}
                </span>
                <span className="text-xs text-slate-400">{KIND_LABEL[m.kind]}</span>
                <span className="ml-auto metric-num text-xs text-slate-400">
                  {m.kind === 'text' ? `${m.byteLen} 字` : ''}
                </span>
                <span
                  className="h-7 px-2 text-xs text-slate-400 hover:text-slate-800"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMaterial.mutate(m.id);
                  }}
                >
                  删除
                </span>
              </button>
              {m.kind === 'url' ? (
                <a
                  href={m.content}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block truncate text-xs text-brand hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {m.content}
                </a>
              ) : (
                <p className="mt-1 truncate text-xs text-slate-500">
                  {expanded[m.id] ? '' : `${m.content.slice(0, 90)}…`}
                </p>
              )}
              {expanded[m.id] && m.kind === 'text' && (
                <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs leading-6 text-slate-700">
                  {m.content}
                </p>
              )}
            </li>
          ))}
          {shownMaterials.length === 0 && (
            <li className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
              还没有资料——「AI 品牌挖掘」会自动归档品牌画像,也可以手动添加文本/链接
            </li>
          )}
        </ul>
      </section>

      {/* ===== 竞品清单与识别口径(增/改/删一体;本品别名在品牌档案表单维护) ===== */}
      <section id="competitor-section" className="card rise-1 mt-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-900">竞品清单({competitors.length})</h2>
          <div className="flex items-center gap-2">
            {pending > 0 && <span className="rounded bg-warn-50 px-2 py-0.5 text-xs text-warn">{pending} 条待确认</span>}
            <button
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              disabled={adding}
              onClick={() => {
                setAdding(true);
                setNewName('');
                setNewAliases('');
              }}
            >
              + 新增竞品
            </button>
          </div>
        </div>
        <p className="mb-3 mt-1 text-xs text-slate-400">
          竞品参与识别与排名口径;AI 建议的条目需确认后才生效。别名逗号分隔(如:问界 M9, M9, 智界)。变更即时落版本快照,历史报告按当时口径复现。
        </p>

        {adding && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand-50/50 p-2.5">
            <input
              autoFocus
              className="w-44 rounded border border-slate-200 px-2 py-1.5 text-sm"
              placeholder="竞品名称 *"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="w-96 rounded border border-slate-200 px-2 py-1.5 text-sm"
              placeholder="别名(逗号分隔,可留空)"
              value={newAliases}
              onChange={(e) => setNewAliases(e.target.value)}
            />
            <button
              className="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              disabled={addCompetitor.isPending || newName.trim().length < 2}
              onClick={() => addCompetitor.mutate({ name: newName.trim(), aliases: newAliases.split(/[,、]/).map((s) => s.trim()).filter(Boolean) })}
            >
              添加
            </button>
            <button className="h-7 px-2 text-xs text-slate-500 hover:text-slate-800" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        )}

        <ul className="space-y-2 text-sm">
          {competitors.map((c) =>
            editingId === c.id ? (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand-50/50 p-2.5">
                <input
                  autoFocus
                  className="w-44 rounded border border-slate-200 px-2 py-1.5 text-sm"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <input
                  className="w-96 rounded border border-slate-200 px-2 py-1.5 text-sm"
                  placeholder="别名(逗号分隔)"
                  value={editAliases}
                  onChange={(e) => setEditAliases(e.target.value)}
                />
                <button
                  className="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  disabled={updateEntry.isPending || !editName.trim()}
                  onClick={saveEdit}
                >
                  保存
                </button>
                <button className="h-7 px-2 text-xs text-slate-500 hover:text-slate-800" onClick={() => setEditingId(null)}>
                  取消
                </button>
              </li>
            ) : (
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
                    onClick={() => startEdit(c)}
                  >
                    编辑
                  </button>
                  <button
                    className="h-7 px-2 text-xs text-slate-500 hover:text-slate-800"
                    onClick={() => removeEntry.mutate(c.id)}
                  >
                    删除
                  </button>
                </span>
              </li>
            ),
          )}
          {competitors.length === 0 && !adding && <li className="text-slate-400">暂无竞品——点右上角「+ 新增竞品」</li>}
        </ul>
        <p className="mt-3 text-[10px] text-slate-400">
          本品别名在上方「品牌档案」表单维护(识别词 = 品牌名)。变更即时落版本快照,历史报告按当时口径复现。
        </p>
      </section>
    </>
  );
}
