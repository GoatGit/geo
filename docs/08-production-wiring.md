# 08 · 生产环境接线手册(阿里云)

> 状态基线:2026-09-14。打 ✅ 的项已在生产验证通过;待办项均需账号侧材料,按本手册执行即可。

## 1. 当前生产拓扑(已部署)

| 组件 | 资源 | 状态 |
|---|---|---|
| 接入 | 经典 CLB `lb-bp1fzv3byjp3gdnc9q4ym`(公网 120.26.225.215),80→3001、443→3001(HTTPS) | ✅ |
| 证书 | Let's Encrypt RSA 2048,`CN=geo.gemux.cn`,至 2026-12-13 | ✅ |
| DNS | `geo.gemux.cn` → 120.26.225.215 | ✅ |
| Web | SAE `geo-web`(cn-hangzhou:geoprod),Next.js,镜像 `web:v3` | ✅ |
| API | SAE `geo-api`,内网 CLB `10.115.0.73:3000` | ✅ |
| Worker | SAE `geo-worker`(调度器 + BullMQ 消费,并发 2,BROWSER_MODE=mock) | ✅ |
| 数据库 | RDS PG18 `pgm-bp1162bs35p43g4y`(公网 `geopub...:15432`),41 表 + 月分区 | ✅ |
| 缓存 | Redis 1G 主备 `r-bp13fae164f9f734`,`maxmemory-policy=noeviction` | ✅ |
| 存证 | OSS `gemux-geo-evidence`(evidence pack:answer/snapshot/manifest) | ✅ |
| 日志 | SLS:四个应用日志收集已配置 | ✅ |
| 采集链路 | 调度 → 轮次 → 队列 → 采集 → mention_facts → rankings API,端到端验证(mentionRate 22/40 输出正常) | ✅ |

已修复的关键问题:账号池为空时任务无限延迟重排(worker 启动时 mock 模式自动补种,见 `apps/worker-web/src/profiles.ts` `ensureMockProfiles`)。

## 2. 短信(阿里云 SMS)——待资质材料

代码侧已就绪:`apps/api/src/auth/auth.service.ts` `AliyunSmsProvider`(POP RPC + HMAC-SHA1)。
当前 `SMS_PROVIDER=console`(验证码进日志,`NODE_ENV=staging` 时接口返回 `devCode`),登录不受影响。

步骤(控制台或等价 OpenAPI):

1. **资质**(create-sms-qualification):上传营业执照(企业)或身份证(个人)。签名审核必须挂资质,无资质无法提交。
2. **签名**:名称建议 `青柠GEO`,来源"网站名"(需 gemux.cn ICP 备案可查)。审核约 2h–2 天。
3. **模板**:类型"验证码",内容:
   `您的验证码为${code}，5分钟内有效，请勿泄露。`
4. **审核通过后**,在 SAE `geo-api` 环境变量中新增/修改,并重启:

```text
SMS_PROVIDER=aliyun
NODE_ENV=production            # 同时停发 devCode,防止验证码回显
ALIYUN_SMS_ACCESS_KEY_ID=<有 dysmsapi SendSms 权限的 AK>
ALIYUN_SMS_ACCESS_KEY_SECRET=<同上>
ALIYUN_SMS_SIGN_NAME=青柠GEO
ALIYUN_SMS_TEMPLATE_CODE=SMS_xxxxxxxx
```

回滚:把 `SMS_PROVIDER` 改回 `console` 即可,登录立即恢复。

## 3. 支付(微信支付 / 支付宝)——待商户凭证

代码侧已就绪:`apps/api/src/billing/`(微信 V3 + 支付宝 RSA2,含回调验签;未配置时下单接口明确报"未配置")。

**微信支付**(需商户号):
1. 商户平台申请 API 证书,拿到:商户号 `mchid`、证书序列号、APIv3 密钥、商户私钥 `apiclient_key.pem`。
2. 平台证书下载后放置到容器内路径(建议打进镜像私有构建或 NAS 挂载,勿入 git)。
3. SAE `geo-api` 环境变量:

```text
WECHAT_PAY_APPID=wx********
WECHAT_PAY_MCHID=**********
WECHAT_PAY_SERIAL_NO=<证书序列号>
WECHAT_PAY_APIV3_KEY=<32位APIv3密钥>
WECHAT_PAY_PRIVATE_KEY_PATH=/app/certs/wechat/apiclient_key.pem
WECHAT_PAY_PLATFORM_CERT_PATH=/app/certs/wechat/platform_cert.pem
```

**支付宝**(需开放平台应用):
1. 开放平台创建"网页/移动应用",签约"电脑网站支付",拿到 `APPID`。
2. 设置"应用私钥/支付宝公钥"(RSA2),密钥文件放入容器路径。
3. SAE `geo-api` 环境变量:

```text
ALIPAY_APP_ID=2021***********
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_PRIVATE_KEY_PATH=/app/certs/alipay/app_private_key.pem
ALIPAY_PUBLIC_KEY_PATH=/app/certs/alipay/alipay_public_key.pem
```

**回调地址**:支付回调经 `X-Forwarded-Proto` 组装,域名走 `https://geo.gemux.cn/api/billing/notify/...`;确认 CLB 443 已透传该头(当前配置已透传)。密钥文件路径以镜像内为准,Dockerfile 部署时用 build secret 注入,不要写进仓库。

## 4. 远程 CDP 浏览器(AgentBay)——待订阅与 Token

代码侧已就绪:`packages/browser-session/src/agentbay-broker.ts`(create → 等待 ready → 取 CDP wss 端点 → 释放),worker `connectOverCDP` 已支持。

1. 开通 AgentBay(百炼云沙箱/Browser Use),确认可用 `browser_latest` 镜像与 CDP 端点能力。
2. 创建 API Token。
3. SAE `geo-worker` 环境变量:

```text
BROWSER_MODE=agentbay
AGENTBAY_API_TOKEN=<token>
AGENTBAY_API_ENDPOINT=https://agentbay.cn-shanghai.aliyuncs.com
AGENTBAY_IMAGE_ID=browser_latest
```

4. **PoC 验证清单**(切换后先小流量,docs/07 §13):
   - 单引擎手工触发一轮,确认 `query_runs.adapter_version` 与快照落 OSS;
   - 引用抽取命中(normalize/parse 无乱码);
   - 会话释放后 AgentBay 控制台实例数回落;
   - 登录态:`account_profiles.status=login_required` 的账号经人工重登恢复(docs/04 §3.1);
   - 压测并发 ≤ WORKER_CONCURRENCY,观察熔断与健康分。

回滚:`BROWSER_MODE=mock` 即回到回放模式,不影响平台其余功能。

## 5. 日常运维备忘

- **证书续期**(到期前 30 天,2026-11-13 起):`acme.sh --issue -d geo.gemux.cn --dns dns_ali --keylength 2048`(必须 RSA;ECC 证书经典 CLB 不支持),然后重跑"拼接 leaf+中间链 → `UploadServerCertificate` → 443 监听换证书 ID"。曾因单 leaf(缺链)与 ECC 两次踩坑,见本文档第 1 节。
- **Redis**:已设 `maxmemory-policy=noeviction`(BullMQ 队列状态不允许被淘汰;内存告警优先扩容而非换策略)。
- **账号池**:mock 模式启动自动补种;真实浏览器模式人工录入,健康分 ≤30 退役、<60 冷却 24h。
- **首轮采集触发**:问题配置完成时 API 会把 `collection_plans.next_run_at` 置 now;调度器 60s tick 派发。手工补触发:`update collection_plans set next_run_at=now() where brand_id=<id>`。
- **geo-db SAE 应用**:已 STOPPED 保留(DB 已迁 RDS),确认稳定后可删除。
- **RDS 公网端点** `geopub...:15432` 仅运维用,建议验证完关闭公网访问。
