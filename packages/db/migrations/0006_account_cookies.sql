-- 0006 账号 Cookie 持久化(docs/04 §3.1):
-- AgentBay Context 同步不可靠(实测绑成功但 Cookie 不跨会话恢复),
-- 登录成功后由 worker 导出 Cookie 落库,采集会话注入,不依赖平台能力。
ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS cookies jsonb;
