-- 示例案例数据(0020):新用户零数据时可见的只读演示内容。
-- is_demo=true 的品牌/问卷对所有账号可读;任何写操作仍走 getOwned 归属校验并明确拒绝。
ALTER TABLE brands ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
