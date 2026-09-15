-- 0005 行业洞察「运行」(docs/01 §3.10 扩展):
-- 报告由采集数据自动聚合生成(worker insights 队列消费),管理员可再手工微调后发布。
-- build_status:idle=就绪/已生成,running=聚合进行中,failed=上次运行失败(build_error 带原因)。
ALTER TABLE industry_insights
  ADD COLUMN IF NOT EXISTS build_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS build_error  text,
  ADD COLUMN IF NOT EXISTS built_at     timestamptz,
  ADD COLUMN IF NOT EXISTS window_days  integer;
