'use client';

/**
 * 登录跳转的场景化理由(docs/research 03 A8 对策延伸):
 * 任何跳登录的场景都带 reason key + next 回跳地址,登录页渲染「为什么要登录」,
 * 登录成功后回到原目标 —— 不让用户对着一个裸登录页猜上下文。
 */

export const LOGIN_REASONS: Record<string, { title: string; desc?: string }> = {
  insight: { title: '登录后可查看行业洞察报告', desc: '行业 AI 可见度实测报告面向注册用户开放' },
  plan: { title: '登录后可开通会员套餐', desc: '选择档位、微信 / 支付宝扫码支付,配额即时生效' },
  report: { title: '登录后可查看报告中心', desc: '周报 / 月报与诊断报告面向会员开放' },
  session: { title: '登录态已过期', desc: '请重新登录后继续操作' },
  console: { title: '登录后进入品牌控制台', desc: '总览、排名透视、口碑与报告等你查看' },
};

/** 校验过的理由 key(未知 key 不渲染横幅)。 */
export function loginReasonKey(raw: string | null | undefined): string | null {
  return raw && LOGIN_REASONS[raw] ? raw : null;
}

/** 构造登录地址:reason 必须在注册表内;next 仅允许站内路径(防开放跳转)。 */
export function buildLoginUrl(reason: string | null | undefined, next?: string): string {
  const params = new URLSearchParams();
  const key = loginReasonKey(reason);
  if (key) params.set('reason', key);
  if (next && next.startsWith('/') && !next.startsWith('//')) params.set('next', next);
  const qs = params.toString();
  return qs ? `/login?${qs}` : '/login';
}

/** 登录成功后的回跳地址:仅接受站内路径,否则落控制台。 */
export function safeNext(raw: string | null | undefined): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
}
