import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '../providers';
import { Shell } from '../components/shell';

export const metadata: Metadata = {
  title: '青柠GEO · AI 搜索品牌可见性监测',
  description: '当用户问 AI 时,你的品牌被推荐了吗、排第几、AI 引用了谁',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
