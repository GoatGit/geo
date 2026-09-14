'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAdmin, tokenStore } from '@/lib/api';

/** 平台后台布局守卫:非 admin 角色回到工作台(接口层 AdminGuard 另有兜底)。 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!tokenStore.access) router.replace('/login');
    else if (!isAdmin()) router.replace('/dashboard');
    else setAllowed(true);
  }, [router]);
  if (!allowed) return null;
  return <div className="space-y-6">{children}</div>;
}
