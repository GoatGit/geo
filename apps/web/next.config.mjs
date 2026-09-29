/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // 页面等非哈希资源禁止长缓存(登录开关等内容在构建期固化,CDN s-maxage 一年
    // 会把旧版本钉在边缘节点——实测强刷命中旧节点出现过已关闭的短信表单);
    // /_next/static 带内容哈希,保持 immutable 长缓存(规则按序先匹配)
    return [
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }],
      },
    ];
  },
  async rewrites() {
    // dev:API 同源代理(生产由 ALB/网关路由 /api 与 /ws)
    const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};

export default nextConfig;
