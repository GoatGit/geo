-- 0002 平台管理后台:账号角色 + 平台级配置。
-- role:平台角色,'user' 租户账号 / 'admin' 平台运营(管理后台唯一入口,由 ADMIN_PHONES 登录时自动授予)。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

-- 平台配置:key-value JSONB,未写入的键取代码内默认值(@geo/shared DEFAULT_PLATFORM_SETTINGS)。
-- 键集:scheduler_enabled / global_daily_run_cap / engine_daily_caps(docs/03 §3.2 调度约束的平台侧旋钮)。
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint
);
