-- 超级问卷(0019):人群池档案合成状态。
-- pending=按配额建格待合成;building=worker 合成中;ready=LLM+库内检索(RAG)合成完成,可确认/作答。
-- 存量池无合成概念,默认 ready 保持可用(向后兼容)。
-- updated_at:合成进度的活性时间戳(worker 每完成一位人物即刷新;building 超 10 分钟无进展可重新认领)。
ALTER TABLE persona_pools ADD COLUMN IF NOT EXISTS synthesis_status text NOT NULL DEFAULT 'ready';
ALTER TABLE persona_pools ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
