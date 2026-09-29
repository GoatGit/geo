/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // HTML 页面禁止长缓存(含登录开关等构建期内容,CDN s-maxage 一年会固化旧版本);
    // /_next/static 资源带内容哈希,保持 immutable 长缓存
    return [
      {
        source: '/:path*',
        has: [{ type: 'header', key: 'content-type', value: 'text/html.*' }],
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
