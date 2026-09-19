-- 0013 行业洞察一等公民(用户分享→审核→发布):
-- submitted_by = 发起分享的账号;share_status = none/pending/approved/rejected;share_note = 用户留言或驳回理由。
ALTER TABLE industry_insights ADD COLUMN IF NOT EXISTS submitted_by bigint;
ALTER TABLE industry_insights ADD COLUMN IF NOT EXISTS share_status text NOT NULL DEFAULT 'none';
ALTER TABLE industry_insights ADD COLUMN IF NOT EXISTS share_note text;
