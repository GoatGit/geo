import type { SurveyQuestion, SurveySegment, SurveyReportStats } from '@geo/shared';
export type { SurveyQuestion, SurveySegment } from '@geo/shared';
export interface SurveyRow {
  id: number; title: string; objective: string; status: string; questions: SurveyQuestion[];
  createdAt: string; updatedAt: string; lastError: string | null; suggestedSegments: SurveySegment[];
  /** 示例调研(0020):全账号可见只读 */
  isDemo?: boolean;
}
export interface SurveyPool {
  id: number; surveyId: number; surveyTitle?: string; size: number; approved: boolean;
  calibrationStatus: string; active?: boolean; sourceMode: string; sourceStats: Record<string, number>; activeCalibrationId?: number | null; spec: { segments: SurveySegment[] };
  /** pending/building=LLM+库内检索合成中;ready=档案完整可确认(0019) */
  synthesisStatus?: 'pending' | 'building' | 'ready' | string;
}
export interface SurveyDetail extends SurveyRow {
  pool: SurveyPool | null; progress: { total: number; completed: number; failed: number }; editable: boolean;
}
export type SurveyReport = SurveyReportStats & {
  title: string; objective: string; status: string; updatedAt: string; disclaimer: string; calibration: import('./calibration').CalibrationRecord | null;
  progress: SurveyDetail['progress']; pool: SurveyPool; suggestedSegments: SurveySegment[]; warnings: string[];
};
export const STATUS: Record<string, { label: string; tone: 'slate' | 'brand' | 'good' | 'warn' | 'bad' }> = {
  draft: { label: '草稿', tone: 'slate' }, generating: { label: '正在生成', tone: 'brand' },
  ready_selecting: { label: '待确认', tone: 'brand' }, queued: { label: '等待作答', tone: 'warn' },
  running: { label: '作答中', tone: 'brand' }, completed: { label: '已完成', tone: 'good' },
  partial: { label: '部分完成', tone: 'warn' }, failed: { label: '待重试', tone: 'bad' }, cancelled: { label: '已取消', tone: 'slate' },
};
export const QUESTION_TYPES = { single: '单选题', multi: '多选题', scale: '量表题', open: '开放题' } as const;
export const busySurvey = (status: string) => ['generating', 'queued', 'running'].includes(status);
export const synthesizing = (pool: SurveyPool | null | undefined) =>
  !!pool && pool.synthesisStatus != null && pool.synthesisStatus !== 'ready';
