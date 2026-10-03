---
name: engine-login
description: 用产品同款远程浏览器(AgentBay)自主完成五大 AI 引擎(豆包/Doubao、DeepSeek、千问/Qwen、文心/百度、元宝/腾讯)的手机号验证码登录,并把登录态写回格尺GEO账号池。当用户要求给账号池补充登录态、批量登录某引擎、账号登录遇到验证码需要人工点选、或提到收码链接(sms.yangsea.top)时使用。
---

# 五大引擎账号池登录技能

本技能**自包含**:驱动代码在本目录 `scripts/engine-login.mjs`,仅依赖 `playwright-core`(技能目录内 `npm i` 即可),不依赖任何项目源码。登录使用与生产采集完全相同的指纹/出口代理/AgentBay Context,成功后凭证经平台 API 回收入池。机械流程(填号/发码/收码/回填)自动执行,**智能体的核心职责是盯实时画面、快速解掉人机验证、处置异常**。

## 一次性配置

仓库内路径为 `skills/engine-login/`。以下命令均在本技能目录执行,要求 Node.js 20+。
该目录使用独立的 npm 锁文件,不属于根目录 pnpm workspace;可整体复制到智能体的技能目录使用。
仓库只保存配置模板,`.env` 中的真实密钥和 `node_modules/` 不纳入版本管理。

1. `cp .env.example .env` 并填写:
   - `GEO_SKILL_API_KEY`:平台管理后台 `/admin/settings` → 全局配置 →「技能接口 API Key」→ 自动生成,复制填入(请求头 `X-API-Key`;重新生成后旧 Key 失效);
   - `AGENTBAY_API_TOKEN`:远程浏览器平台 Token(与生产采集一致);
   - 其余项按 .env.example 注释核对。
2. `npm ci`(技能目录内,按锁文件仅装 playwright-core;浏览器在远程沙箱,本地无需下载)。

推荐使用 `GEO_SKILL_API_KEY`;仅在开发环境未配置技能 Key 时,可显式填写 `GEO_ADMIN_PHONE`
使用服务端返回的 `devCode` 登录。脚本不内置管理员手机号。

## 启动登录

```bash
cd <本技能目录>
node scripts/engine-login.mjs --engine=deepseek --sms-link='<收码链接>' --profile-id=<档案ID> --keep=60 > /tmp/engine-login.log 2>&1 &
```

- 引擎:`deepseek|doubao|qwen|wenxin|yuanbao`;`--profile-id` = 账号池档案 ID(管理后台 /admin/accounts)
- 脚本自动:读档案指纹/出口/Context → AgentBay 建会话 → 打开站点 → 机械流 → 校验 → 导出 Cookie 入池
- `--manual`:跳过机械流,智能体全程经 cmd.json 驱动,完成后 `touch <截图目录>/done.flag` 强制入池判定
- 日志 `/tmp/engine-login.log`(有缓冲延迟,**以画面为准**);截图目录在日志前几行,`live.jpg` 每 2 秒刷新

## 智能体主循环(登录期间)

每 15~25 秒一轮,直到登录成功或失败:

1. `Read /tmp/auto-login-debug/<dir>/live.jpg` 观察画面;
2. 发现人机验证 → **立即**按下方"验证码解法"写 `/tmp/auto-login-debug/<dir>/cmd.json`;
3. `tail -5 /tmp/engine-login.log` 看状态行推进。

**速度是第一要务**:收码站收取窗口约 65 秒(超时自动换号、旧号短信作废)。验证码弹出后要在 ~40 秒内解掉(系统检测到验证码会自动续窗口,但不要依赖它)。

## cmd.json 命令格式(写入即注入远程页面,坐标 = live.jpg 像素坐标)

```json
{"type":"click","x":785,"y":425}
{"type":"type","text":"433604"}
{"type":"key","key":"Enter"}
{"type":"drag","fromX":300,"fromY":500,"toX":700,"toY":500}
```

## 验证码解法(逐引擎)

- **DeepSeek(必现)**:3D 物体点选,弹窗标题即题目,如"点击图中最小的黄色六棱柱/蓝色圆锥"。看清题干限定(颜色+形状+大小),在画面中找唯一匹配物体,点其中心。常见形状:圆锥(三角锥形)、棱柱/长方体(盒状)、圆柱、球。物体有远近大小之分,"最小"按视觉尺寸判断。
- **豆包**:通常无验证码;偶尔弹"下载电脑版"推广(脚本自动关)。
- **元宝**:「服务协议及隐私保护」弹窗(脚本自动点同意);偶尔滑块。
- **千问/文心**:偶发滑块拖动(`{"type":"drag",...}`,从滑块头拖到缺口)。
- 验证码会刷新/重弹:解完看新帧,可能需要连续解 2~3 次。

## 成功与失败判定

- 成功:日志出现 `✅ 凭证已入池:档案 #N 置 available`;随后 `curl -s "$GEO_API_BASE/api/admin/accounts" -H "x-api-key: $GEO_SKILL_API_KEY"` 复核该档案 status=available(此端点仍需管理员 JWT 时,直接看管理后台账号池页面)。
- 收码站问题:状态行"收码站判定号码失败(次数已用尽 x/3)"= 链接额度耗尽,向用户要新链接;"收码站已换号"= 窗口过期轮换,流程自动用新号重走(继续解验证码即可);"HTTP 409 正在换号"= 站方轮换中,脚本自动重试。
- 自动机械流失败 → 改 `--manual` 重跑,智能体全程驱动(点登录入口 → 切手机号页签 → 填号 → 发码 → 解验证码 → 回填 → 点登录),完成后 `touch <dir>/done.flag`。

## 收码站约束(sms.yangsea.top)

- 查额度:`curl -s "https://sms.yangsea.top/api/session?t=<TOKEN>&slot=1"`,看 `status/attempt/max_attempts/completed_count/quantity`。`quantity=1` 的链接收 1 条码即耗尽;`attempt 3/3` = 号码额度用尽。
- 链接形如 `https://sms.yangsea.top/?t=<TOKEN>`,一条链接对应一个档案的登录。
- 手机号验证码 60 秒有效;流程收到即自动回填,无需干预。

## 登录态与采集的一致性(勿破坏)

- 脚本用档案绑定的**出口代理**登录(Cookie 与 IP 绑定),入池时自动回写出口绑定;不要绕过代理直连登录。
- 凭证入池:`POST {GEO_API_BASE}/api/admin/accounts/:id/credentials`(storageState + contextId + proxyServer,请求头 `X-API-Key`),脚本自动调用。
- 技能 Key 只能访问机器面端点(登录上下文读取、凭证回收),不能访问其它管理接口。
