-- 0014 安全修正:降级临时调试账号(曾在临时 ADMIN_PHONES 期间登录被持久化 admin;
-- 角色升级不随 env 移除自动降级,一次性数据修正)
UPDATE accounts SET role = 'user' WHERE phone = '13800138000' AND role = 'admin';
