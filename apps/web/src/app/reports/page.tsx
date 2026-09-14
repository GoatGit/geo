'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, brandStore } from '../../lib/queries';
import { PageHeader, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';

interface ReportRow {
  id: number;
  type: string;
  period: string;
  status: string;
  payloadRef: string | null;
  createdAt: string;
}

/** 报告中心(docs/01 §3.8):列表 + 手动生成;周报每周一自动生成(worker cron)。 */
export default function ReportsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const brandId = brandStore.get();
  const reports = useQuery({
    queryKey: ['reports', brandId],
    queryFn: () => api<ReportRow[]>('/reports'),
  });

  const generate = useMutation({
    mutationFn: (type: string) =>
      api('/reports/generate', { method: 'POST', json: { brandId, type } }),
    onSuccess: () => {
      toast('报告已加入生成队列');
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });

  if (!brandId) return <Skeleton />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="报告中心"
        actions={
          <>
            <button className="btn-ghost" onClick={() => generate.mutate('weekly')}>
              生成周报
            </button>
            <button className="btn-primary" onClick={() => generate.mutate('monthly')}>
              生成月报
            </button>
          </>
        }
      />

      <section className="table-wrap rise-1">
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr>
              <th className="px-4 py-2.5">类型</th>
              <th className="px-4 py-2.5">周期</th>
              <th className="px-4 py-2.5">状态</th>
              <th className="px-4 py-2.5">生成时间</th>
            </tr>
          </thead>
          <tbody>
            {reports.data?.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2.5">{r.type === 'weekly' ? '周报' : r.type === 'monthly' ? '月报' : '体检'}</td>
                <td className="metric-num px-4 py-2.5">{r.period}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      r.status === 'done' ? 'bg-good-50 text-good' : r.status === 'failed' ? 'bg-bad-50 text-bad' : 'bg-slate-100'
                    }`}
                  >
                    {r.status === 'done' ? '已完成' : r.status === 'failed' ? '失败' : r.status === 'generating' ? '生成中' : '排队中'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
              </tr>
            ))}
            {reports.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  首份报告将在首轮采集完成后可生成
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
