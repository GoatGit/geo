-- 0018 微信扫码登录(docs/01 登录方式扩展):
-- ① accounts.phone 放开可空——微信登录的账号以 openid 为身份主键,手机号可后绑
-- ② 新增 wechat_openid / wechat_unionid(unionid 跨应用打通同一主体的多个应用)
ALTER TABLE accounts ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wechat_openid text UNIQUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wechat_unionid text;
