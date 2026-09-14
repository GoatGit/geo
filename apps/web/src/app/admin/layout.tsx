'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isAdmin, tokenStore } from '@/lib/api';
import { buildLoginUrl } from '@/lib/login-reasons';

/** 平台后台布局守卫:非 admin 角色回到工作台(接口层 AdminGuard 另有兜底)。 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!tokenStore.access) router.replace(buildLoginUrl('console', pathname));
    else if (!isAdmin()) router.replace('/dashboard');
    else setAllowed(true);
  }, [router, pathname]);
  if (!allowed) return null;
  return <div className="space-y-6">{children}</div>;
}
