# 08 · 生产环境接线手册(阿里云)

> 状态基线:2026-09-14。打 ✅ 的项已在生产验证通过;待办项均需账号侧材料,按本手册执行即可。

## 1. 当前生产拓扑(已部署)

| 组件 | 资源 | 状态 |
|---|---|---|
| 接入 | 经典 CLB `lb-bp1fzv3byjp3gdnc9q4ym`(公网 120.26.225.215),80→3001、443→3001(HTTPS) | ✅ |
| 证书 | Let's Encrypt RSA 2048,`CN=geo.gemux.cn`,至 2026-12-13;续期脚本 `scripts/renew-https-cert.sh` | ✅ |
| DNS | `geo.gemux.cn` → 120.26.225.215 | ✅ |
| Web | SAE `geo-web`(cn-hangzhou:geoprod),Next.js,镜像 `geo:v3` | ✅ |
| API | SAE `geo-api`,内网 CLB `10.115.0.73:3000`,镜像 `geo:v4`(含短信预埋与 ADMIN_PHONES) | ✅ |
| Worker | SAE `geo-worker`(调度器 + BullMQ 消费,并发 2,BROWSER_MODE=mock),镜像 `geo:v4`(校准版 broker) | ✅ |
| 数据库 | RDS PG18 `pgm-bp1162bs35p43g4y`(公网 `geopub...:15432`),41 表 + 月分区 | ✅ |
| 缓存 | Redis 1G 主备 `r-bp13fae164f9f734`,`maxmemory-policy=noeviction` | ✅ |
| 存证 | OSS `gemux-geo-evidence`(evidence pack:answer/snapshot/manifest) | ✅ |
| 日志 | SLS:四个应用日志收集已配置 | ✅ |
| 公网出口 | geo-api / geo-worker 各绑定按量 EIP(短信/AgentBay 公网端点所需),2026-09-15 | ✅ |
| 采集链路 | 调度 → 轮次 → 队列 → 采集 → mention_facts → rankings API,端到端验证(mentionRate 22/40 输出正常) | ✅ |
| 远程采集 | worker 已切 agentbay 模式(cn-hangzhou),CDP 端到端 PoC 通过(playwright 连 CDP 导航 example.com 成功) | ✅ |

已修复的关键问题:账号池为空时任务无限延迟重排(worker 启动时 mock 模式自动补种,见 `apps/worker-web/src/profiles.ts` `ensureMockProfiles`)。

## 2. 短信(阿里云 SMS)——待资质材料

代码侧已就绪:`apps/api/src/auth/auth.service.ts` `AliyunSmsProvider`(POP RPC + HMAC-SHA1)。
**预埋已完成**:geo-api 已带 `ALIYUN_SMS_ACCESS_KEY_ID/SECRET`、`ALIYUN_SMS_SIGN_NAME=青柠GEO` 重启生效;
`SMS_PROVIDER` 当前仍为 `console`(`NODE_ENV=staging` 时接口返回 `devCode`),登录不受影响。

依赖链(实测确认):验证码模板 → 关联签名 → 资质 → 证件材料;且**资质创建无 OpenAPI**(仅有查询/删除/更换),必须控制台上传。

唯一的人工步骤(约 3 分钟):
> 阿里云短信控制台 → 国内消息 → 资质管理 → 添加资质(上传营业执照或身份证照片)→ 提交审核

之后一切自动化:
```bash
scripts/wire-sms.sh   # 自动等资质审核通过 → 提交签名「青柠GEO」→ 提交验证码模板 → 轮询审核 → 打印收尾环境变量
```
签名/模板审核通过后,把脚本打印的 `ALIYUN_SMS_TEMPLATE_CODE` 加到 SAE geo-api,
同时改 `SMS_PROVIDER=aliyun`、`NODE_ENV=production`(停发 devCode),重启 geo-api。

回滚:把 `SMS_PROVIDER` 改回 `console` 即可,登录立即恢复。

**实测补充(2026-09-15)**:
- `SendSms` API 已用生产 AK 实测打通——签名算法、AK dysmsapi 权限均正确,错误只到业务层
  (测试签名未激活)。资质/签名/模板审核通过后切换无任何 API 侧风险。
- **最快真实短信验证路径**(限少量测试手机号,可选):控制台短信页激活"测试专用签名
  「阿里云短信测试」"并绑定测试手机号 → `SMS_PROVIDER=aliyun` +
  `ALIYUN_SMS_SIGN_NAME=阿里云短信测试` + `ALIYUN_SMS_TEMPLATE_CODE=SMS_154950909`
  → 绑定的手机号即可收到真实短信(生产用户仍需走正式资质流程)。
  绑定测试手机号也可 CLI 完成:`aliyun dysmsapi send-test-verification --api-version 2017-05-25 --phone <你的手机号>`
  (会向你手机发验证码,输入即完成绑定)。

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

## 4. 远程 CDP 浏览器(AgentBay)——✅ 已接线(2026-09-15)

代码侧已校准(W1-2 完成):broker 按 POP RPC 协议重写——端点 `agentbay.cn-shanghai.aliyuncs.com`、
Version 2025-05-06、`Authorization: Bearer <akm-key>` 在 form body(与官方 wuying-agentbay-sdk 一致)。

**密钥双层结构(实测)**:`ak-` KeyId 仅用于管理,会话鉴权必须用 `akm-` 完整密钥;
完整值仅在控制台创建时展示一次,API 只回 KeyId、列表打码。

唯一的人工步骤(约 1 分钟):
> AgentBay 控制台(无影 AI)→ API Key → 创建(或查看已有)→ 复制 `akm-` 完整值

之后一键接线:
```bash
AGENTBAY_TOKEN=akm-xxxx scripts/wire-agentbay.sh
# 脚本会:本地验证密钥(建/删测试会话)→ SAE geo-worker 切 agentbay 模式 → 触发采集 PoC 对比 query_runs
```

4. **PoC 验证清单**(脚本跑完后人工复核):
   - 单引擎手工触发一轮,确认 `query_runs.adapter_version` 与快照落 OSS;
   - 引用抽取命中(normalize/parse 无乱码);
   - 会话释放后 AgentBay 控制台实例数回落;
   - 登录态:`account_profiles.status=login_required` 的账号经人工重登恢复(docs/04 §3.1);
   - 压测并发 ≤ WORKER_CONCURRENCY,观察熔断与健康分。

回滚:`BROWSER_MODE=mock` 即回到回放模式,不影响平台其余功能。

## 5. 日常运维备忘

- **证书续期**(到期前 30 天,2026-11-13 起):执行 `scripts/renew-https-cert.sh`(签发 RSA → 拼 leaf+中间链 → 上传 → 切换 443 监听 → 验证)。曾因单 leaf(缺链)与 ECC 两次踩坑,脚本已内建规避。
- **80 端口**:SAE BindSlb 管理的是 TCP 监听,CLB 层无法做 HTTP→HTTPS 跳转;如需强制跳转,在 Next.js 层按 `x-forwarded-proto` 做(CLB 健康检查 3xx 视为成功,不影响)。
- **支付回调**:`/api/billing/notify/wechat|alipay` 已在 HTTPS 下可达(对无签名请求返回 401 属预期验签行为);staging 下未配置凭证时下单自动落 mock 通道,凭证配置后真实通道自动激活。
- **Redis**:已设 `maxmemory-policy=noeviction`(BullMQ 队列状态不允许被淘汰;内存告警优先扩容而非换策略)。
- **账号池**:mock 模式启动自动补种;真实浏览器模式人工录入,健康分 ≤30 退役、<60 冷却 24h。
- **首轮采集触发**:问题配置完成时 API 会把 `collection_plans.next_run_at` 置 now;调度器 60s tick 派发。手工补触发:`update collection_plans set next_run_at=now() where brand_id=<id>`。
- **geo-db SAE 应用**:已 STOPPED 保留(DB 已迁 RDS),确认稳定后可删除。
- **RDS 公网端点**:2026-09-15 起公网 `geopub...:15432` 已不可达(符合安全建议)。所有运维走 VPC 内网(如 SAE 临时任务或同 VPC 跳板);本地开发用内网穿透或临时白名单。
