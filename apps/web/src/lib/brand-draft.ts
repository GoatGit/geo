'use client';

/**
 * 官网首页品牌输入暂存(geo.brandDraft):
 * 首页输入 → 登录/注册是整页跳转,提交时把输入落 localStorage,
 * /brands/new 挂载时读取一次预填表单并清除,避免用户输入丢失。
 */
const KEY = 'geo.brandDraft';

export interface BrandDraft {
  /** 品牌自然语言描述(首页输入框只有一个字段,对应新建品牌页的 description) */
  description?: string;
}

export function saveBrandDraft(draft: BrandDraft): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(draft));
}

/** 读取并立即清除草稿(一次性);无草稿/JSON 损坏时返回 null。 */
export function takeBrandDraft(): BrandDraft | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(KEY);
  if (!v) return null;
  localStorage.removeItem(KEY);
  try {
    const d = JSON.parse(v) as BrandDraft;
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}
