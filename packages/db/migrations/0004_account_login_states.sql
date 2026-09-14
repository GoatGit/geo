-- 0004 账号池人工登录(docs/04 §3.1 账号生命周期):
-- pending_login = 已登记档案等待人工注入账号态;login_required = 登录态失效需重登。
ALTER TABLE account_profiles DROP CONSTRAINT IF EXISTS account_profiles_status_check;
ALTER TABLE account_profiles ADD CONSTRAINT account_profiles_status_check
  CHECK (status IN ('available', 'cooldown', 'retired', 'banned', 'pending_login', 'login_required'));
