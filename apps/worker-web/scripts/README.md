# worker-web scripts

运维与校准脚本目录。均为主程序之外的独立脚本,不随生产镜像发布(Dockerfile runtime 阶段只拷贝 `dist/`)。

## 常驻脚本(scripts/)

| 脚本 | 用途 |
|------|------|
| calibrate.ts | 站点 DOM 校准:页面改版后对指定引擎跑登录检测/输入框/提交/回答容器选择器命中清单(docs/04 §7) |
| doubao-live.ts | 豆包会话连续性 PoC:同一 AgentBay 会话内连续两轮提问,判定登出风控触发点 |
| cdp-page-probe.js | CDP 直连探针:对指定聊天页探测给定 CSS 选择器的命中数与可见性(选择器校准) |
| cdp-submit-probe.js | CDP 直连探针:探测聊天页发送按钮/发送文案的候选选择器(提交动作校准) |
| debug-viewer.mts | 本地登录调试查看器:远程截帧 + 点击/文字注入,每 5s 打印 checkLogin 判定与 Cookie 变化(校准 loggedInCookieHints) |
| clean-mock-runs.mjs | 清洗 mock 回放数据:删除 adapter_version='mock-1' 的 runs 与事实并重算 totals(幂等) |
| oneoff-cleanup-brand.mjs | 一次性运维:删除指定品牌及全部从属数据(不可逆,谨慎) |
| screenshot-pages.mjs | 视觉自查:系统 Chrome 无头对官网/登录/控制台全部页面截图到 /tmp/geo-shots/ |
| agentbay-probe.py | AgentBay 会话探针:列出/检查当前会话与 CDP 链接状态 |
| cdp-session.py | AgentBay 会话管理:创建/销毁会话并取 CDP 链接 |
| check-all.py | 批量核验:SAE 三应用状态 + 数据库连通 + 关键表行数汇总 |
| check-sae.py | 单项核验:查询指定 SAE 应用当前状态与实例数 |
| create-pull-secret.py | 在 SAE 命名空间创建 ACR 镜像拉取 Secret |
| create-sls-project.py | 创建/配置 SLS 日志项目与采集配置 |
| deploy-finish.py | 部署收尾:环境变量注入、变更单确认等发布后置步骤 |
| dump-logs.py | 拉取 SLS 日志到本地排查 |
| flip-worker-mode.py | 切换 Worker 的 BROWSER_MODE(mock/agentbay)环境变量并重启 |
| probe-db.py | 生产库直查探针:执行只读 SQL 验证表结构与数据 |
| prod-status.py | 生产全景状态:SAE/RDS/Redis/OSS 关键指标一览 |
| worker-log.py | 按 runId/时间窗检索 Worker 采集日志 |

## archive/(历史一次性脚本)

调试期产生的一次性排查脚本,仅作历史存档,**不保证可运行**(可能依赖已变更的接口/选择器/数据):

| 脚本 | 当年用途 |
|------|----------|
| cdp-probe.js | 早期 DeepSeek 登录态探针:直连 CDP 检查 sessionid cookie 与跳转 |
| cdp-inject-test.js | Cookie 注入机制验证:注入探针 cookie 后导航再读回,确认 CDP 注入链路可用 |
| debug-login-recon.mts | 多引擎扫码登录并行调试器(debug-viewer.mts 的多引擎前身) |
| test-doubao-stage.mts | 豆包分阶段采集验证:建会话→登录→提问→截图逐步探路 |
| test-stage2.mts | 豆包第二阶段(提交/回答抽取)选择器验证 |
| verify-doubao.mts | 豆包账号全链路验证:dev 短信登录→账号池登录→跑一轮采集观察 |
| logincheck.mjs | 本地 /login 页截图与控制台报错收集(登录页修复期) |
| shot-collapse.mjs | dashboard 侧栏收起交互截图(前端布局调整期) |
| cdp-ctx-proxy.js | 代理链路排查:检查 CDP 会话 context 代理绑定形态 |
| cdp-egress-probe.js | 出口 IP 探针:经代理访问回显服务确认真实 egress(代理链路验证期) |
| cdp-full-proxy-test.js | 全链路代理验证:建会话→绑代理→导航→提问一步不落 |
| cdp-nav-proxy.js | 导航代理验证:代理下页面 goto 是否走代理出口 |
| cdp-port-test.js | 代理端口连通性测试( socks/http 端口探测) |
| cdp-proxy-test.js | 代理基础连通测试:CDP 会话内代理是否生效 |
