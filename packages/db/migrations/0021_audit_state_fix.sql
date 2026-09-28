-- 口碑抽检(0021):统一 audit_state 完成态为 CHECK 允许的 'done'。
-- 此前 API 写 'audited' 违反 CHECK(none/pending/done)→ 抽检按钮 500;
-- 历史误写入的 'audited'(如有)一并修正。
UPDATE reputation_facts SET audit_state = 'done' WHERE audit_state = 'audited';
