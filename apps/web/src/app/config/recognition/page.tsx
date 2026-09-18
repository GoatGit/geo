'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useBrandId } from '@/lib/queries';
import { useToast } from '@/components/toast';
import { PageHeader, Skeleton } from '@/components/ui';

interface RecognitionRow {
  id: number;
  kind: 'self' | 'competitor';
  name: string;
  aliases: string[];
  note: string | null;
  confirmed: boolean;
}

/**
 * 识别口径管理(docs/01 IA ④,口径单一事实源):
 * 本品识别词+别名 / 竞品清单;每次保存落口径版本(docs/research 03-B 对策)。
 */
export default function RecognitionPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const brandId = useBrandId();
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [kind, setKind] = useState<'self' | 'competitor'>('competitor');

  const rows = useQuery({
    queryKey: ['recognition', brandId],
    queryFn: () => api<RecognitionRow[]>(`/brands/${brandId}/recognition`),
    enabled: !!brandId,
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/brands/${brandId}/recognition`, {
        method: 'POST',
        json: { kind, name, aliases: aliases.split(/[,、]/).map((s) => s.trim()).filter(Boolean) },
      }),
    onSuccess: () => {
      toast('识别口径已保存,版本快照已记录');
      setName('');
      setAliases('');
      void qc.invalidateQueries({ queryKey: ['recognition'] });
    },
  });

  const setConfirmed = useMutation({
    mutationFn: ({ entryId, confirmed }: { entryId: number; confirmed: boolean }) =>
      api(`/brands/${brandId}/recognition/${entryId}`, { method: 'PATCH', json: { confirmed } }),
    onSuccess: () => {
      toast('已更新,版本快照已记录');
      void qc.invalidateQueries({ queryKey: ['recognition'] });
    },
  });

  const removeEntry = useMutation({
    mutationFn: (entryId: number) =>
      api(`/brands/${brandId}/recognition/${entryId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('已删除');
      void qc.invalidateQueries({ queryKey: ['recognition'] });
    },
  });

  if (!brandId) return <Skeleton />;

  const self = rows.data?.find((r) => r.kind === 'self');
  const competitors = rows.data?.filter((r) => r.kind === 'competitor') ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="识别口径" />

      <section className="card rise-1 p-6">
        <h2 className="mb-2 text-sm font-medium">本品识别口径</h2>
        {self ? (
          <p className="text-sm">
            识别词:<b>{self.name}</b>
            <span className="ml-3 text-slate-500">别名:{self.aliases.length > 0 ? self.aliases.join('、') : '(无)'}</span>
          </p>
        ) : (
          <p className="text-sm text-slate-400">尚未配置</p>
        )}
      </section>

      <section className="card p-6">
        <h2 className="mb-2 text-sm font-medium">竞品清单({competitors.length})</h2>
        <p className="mb-3 text-xs text-slate-400">
          AI 建议的竞品需确认后才会参与识别;误识别的条目可直接删除。
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

      <section className="card rise-2 p-6">
        <h2 className="mb-3 text-sm font-medium">新增 / 更新口径</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded border px-2 py-1.5 text-sm" value={kind} onChange={(e) => setKind(e.target.value as never)}>
            <option value="competitor">竞品</option>
            <option value="self">本品别名补充</option>
          </select>
          <input className="w-44 rounded border px-2 py-1.5 text-sm" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className="w-96 rounded border px-2 py-1.5 text-sm"
            placeholder="别名(逗号分隔,如:SU7, YU7, 小米SU7)"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
          <button
            className="rounded bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={save.isPending || name.trim().length < 2}
            onClick={() => save.mutate()}
          >
            保存
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-400">保存即生效并落口径版本快照,历史报告按当时口径复现。</p>
      </section>
    </div>
  );
}
