# SAE 部署说明(docs/07 §2-§3)

## 应用拓扑

| SAE 应用 | 启动命令 | 实例规格(起步) | 弹性 |
|----------|----------|------------------|------|
| geo-web | `node apps/web/node_modules/.bin/next start -p 3001` | 0.5vCPU/1G ×1 | CPU |
| geo-api | `node apps/api/dist/main.js` | 1vCPU/2G ×1-2 | CPU;WS 经绑定 ALB/CLB |
| geo-worker | `node apps/worker-web/dist/main.js` | 1vCPU/2G ×1-2 | 定时弹性(白天扩)+ 自定义指标(队列深度,Prometheus) |

## 部署步骤(发布流水线)

1. ACR 构建镜像(根目录 Dockerfile);
2. SAE 三个应用分别指向同一镜像,配置不同启动命令与环境变量(见根目录 `.env.example`);
3. RDS PostgreSQL:发布前执行 `pnpm db:migrate`(或发布后由 worker 启动兜底执行分区预建);
4. OSS:创建 geo-evidence 桶,配置 **合规保留策略(WORM)** 与录屏前缀 7 天生命周期(docs/07 §6);
5. AgentBay:开通 **Pro 权益包**(CDP 端点前置),配置 `AGENTBAY_API_TOKEN`;
6. 域名 ICP 备案完成后接入阿里云短信(签名/模板报备),`SMS_PROVIDER=aliyun`;
7. 告警:引擎成功率、会话积分消耗速率、队列积压 → 钉钉(docs/07 §11)。

## PoC 闸门(切 agentbay 模式前必须全绿,docs/07 §13)

1. `browser_latest` 会话内 CDP Network 域可截获引擎 SSE;
2. BrowserOption 自定义住宅代理可用;
3. Browser Context 跨会话保登录态 ≥7 天;
4. `getEndpointUrl` 与 Playwright 多 Tab 兼容;
5. 冷启动 ≤15s、吞吐 ≥30 查询/会话小时;
6. Basic 包是否含 CDP 端点。

任一不成立 → 保持 mock/BROWSER_MODE,触发降级评估(docs/07 §4.6,自建 Chromium 池实现)。
