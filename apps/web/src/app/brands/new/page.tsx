'use client';
import { engineLabel } from '@geo/shared';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, brandStore } from '@/lib/api';
import { takeBrandDraft } from '@/lib/brand-draft';
import { useToast } from '@/components/toast';

/** 品牌初始化(docs/01 §3.1):自然语言 → 档案 + 识别口径预填(含自有产品线别名)。 */
export default function NewBrandPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [result, setResult] = useState<{
    brand: { id: number; name: string };
    profileDraft: { suggestedAliases: string[]; suggestedCompetitors: Array<{ name: string }> };
    engines: string[];
    plan: string;
  } | null>(null);

  // 官网首页带入的品牌输入:挂载时读取一次并预填(读后即清,避免残留到后续会话)
  useEffect(() => {
    const draft = takeBrandDraft();
    if (draft?.description) setDescription(draft.description);
  }, []);

  const create = useMutation({
    mutationFn: () =>
      api<{
        brand: { id: number; name: string };
        profileDraft: { suggestedAliases: string[]; suggestedCompetitors: Array<{ name: string }> };
        engines: string[];
        plan: string;
      } | null>('/brands', { method: 'POST', json: { description } }),
    onSuccess: (r) => {
      if (r) {
        toast('品牌创建成功,识别口径已预填');
        setResult(r);
        brandStore.set(r.brand.id);
        void qc.invalidateQueries({ queryKey: ['brands'] });
      }
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">创建品牌</h1>
      </header>

      <textarea
        className="h-36 w-full rounded border p-3 text-sm"
        placeholder={'我的品牌叫「小米汽车」,是小米公司旗下的智能电动汽车品牌,主打高性能纯电轿车和SUV,官网是 https://www.xiaomiev.com ,主要竞品是特斯拉、理想、蔚来和极氪'}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <button
        className="rounded bg-brand px-5 py-2 text-sm text-white disabled:opacity-50"
        disabled={create.isPending || description.trim().length < 10}
        onClick={() => create.mutate()}
      >
        解析并创建
      </button>

      {result && (
        <div className="space-y-3 rounded-lg border bg-white p-5 text-sm">
          <p>
            已创建品牌:<b>{result.brand.name}</b> · 套餐 {result.plan} · 引擎 {result.engines.map(engineLabel).join('/')}
          </p>
          <p>
            建议识别别名(已默认登记):
            <span className="ml-1 text-slate-500">{result.profileDraft.suggestedAliases.join('、') || '(描述中未发现型号)'}</span>
          </p>
          <p>
            建议竞品(待确认):
            <span className="ml-1 text-slate-500">
              {result.profileDraft.suggestedCompetitors.map((c) => c.name).join('、') || '(无)'}
            </span>
          </p>
          <div className="flex gap-2 pt-1">
            <button
              className="rounded bg-brand px-4 py-2 text-sm text-white"
              onClick={() => router.push('/config/questions')}
            >
              下一步:添加监控问题 →
            </button>
            <button className="rounded border px-4 py-2 text-sm" onClick={() => router.push('/config/brand')}>
              先核对识别口径
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
