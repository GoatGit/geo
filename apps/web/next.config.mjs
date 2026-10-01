/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // 页面等非哈希资源禁止长缓存(登录开关等内容在构建期固化,CDN s-maxage 一年
    // 会把旧版本钉在边缘节点——实测强刷命中旧节点出现过已关闭的短信表单);
    // /_next/static 带内容哈希,保持 immutable 长缓存(规则按序先匹配)
    const base = [
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
          // 安全响应头:token 存 localStorage 的前提下,收敛 XSS/点击劫持外溢面
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
    // CSP 仅生产启用:dev 直连 localhost:3000/3001 与 HMR 会被严格 CSP 打断;
    // script 'unsafe-inline' 是 Next 水合引导的必要妥协,但仍封 object/base-uri 与外联脚本
    if (process.env.NODE_ENV === 'production') {
      base.splice(1, 0, {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      });
    }
    return base;
  },
  async rewrites() {
    // dev:API 同源代理(生产由 ALB/网关路由 /api 与 /ws)
    const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};

export default nextConfig;
