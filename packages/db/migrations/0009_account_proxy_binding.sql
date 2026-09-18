-- 出口租约绑定(IP 亲和,采集事故复盘):同一账号档案的登录与采集必须走同一出口 IP,
-- 引擎风控把会话 Cookie 绑定到登录时的出口;跨 IP 会话会被判 needs_login。
-- 记录档案上次成功登录/采集所用的青果租约 server(ip:port),供代理池按档案复用同一租约。
ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS proxy_server text;
