'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { tokenStore } from '../lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(tokenStore.access ? '/dashboard' : '/login');
  }, [router]);
  return null;
}
