# 账号池登录修复发布记录

- 日期：2026-09-18，Asia/Shanghai。
- 站点：https://geo.gemux.cn/admin/accounts
- SAE：`cn-hangzhou:geoprod`，geo-api、geo-worker、geo-web。
- 新版本：`v57-login-20260918`；上一版本：`v56`。
- 发布源码快照：`87e861868288639fa933de766cd4bdb9b6c0f995`，由本次工作区修复生成独立 worktree 提交；原工作区未重置。
- 镜像摘要：`sha256:92c19108d2c2d7f844adb3201d072bf493a18110a4d9535171e0a63ccfc80a25`。
- 镜像平台：`linux/amd64`；Web 构建时 API_ORIGIN 为 `http://10.115.0.73:3000`。

## 发布结果

1. 在生产 VPC 的一次性 SAE 任务中执行 `0011_account_storage_state.sql`，验证新增列为 jsonb，并登记 schema_migrations。
2. 保留发布前正在等待确认的 DeepSeek 登录，先更新 API/Web，待该会话终态后更新 Worker。
3. 三个应用的变更单全部成功，状态均为 `RUNNING/NORMAL`，每个应用一个实例；环境变量及启动命令保持原配置。
4. 清理滚动交接期间旧 Worker 遗留的两条会话锁。清理按会话 ID、状态和更新时间比较后执行，不覆盖已更新的会话。

变更单：

| 应用 | ChangeOrderId |
| --- | --- |
| API | `978d51eb-3c39-4e67-b56b-5cfe9626c3fb` |
| Web | `44679c45-b562-4654-8a24-84c1aa817c2c` |
| Worker | `ebd8b714-b27e-4e7d-81c2-f0b0cef2cb94` |

## 线上验证

- HTTPS 首页、登录后的账号池页面及管理接口正常；账号池显示 26 个档案，页面无浏览器异常。
- 新接口返回 `loginSessionId`，支持刷新后恢复活动登录。
- 数据库、Redis 可用，Worker 新版本心跳正常。
- 使用空闲待登录档案验证豆包及 DeepSeek：创建云端浏览器、返回 JPEG 实时画面、重复请求复用会话、接收 Tab 输入、取消后清除会话锁。
- 目视确认豆包二维码/手机号登录弹窗及 DeepSeek 手机号/微信登录页面。
- 豆包档案 #20 在此次验证期间返回真实 `done` 状态并进入可用池；数据库确认 storageState 已保存 29 条 Cookie、1 个 origin，保留该登录结果。
- 旧 DeepSeek 档案 #3 虽显示 available，但本次只读核验确认尚无 storageState，需要重新登录；#21 仍为待登录。
- 未发送短信，未代填用户凭证。DeepSeek 完整登录和后续采集仍需操作者完成；旧档案应重新登录以补存 localStorage。

## 回滚

必要时将三个 SAE 应用镜像一起改回 `v56`，保留现有环境变量与启动命令。新增的 `storage_state` 列向后兼容，回滚无需删除。

受限权限的发布配置快照、迁移日志、线上验证结果保存在 `/tmp/geo-login-release-20260918/`；其中配置快照包含凭据，不应提交或公开。

迁移及收尾临时任务均已删除，临时验证 token 文件已清理。
