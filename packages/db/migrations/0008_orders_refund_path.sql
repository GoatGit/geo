-- 退款路径修复:0003 的 orders_no_delete 触发器对 paid 行 BEFORE UPDATE 无条件拦截,
-- 连 ORDER_STATUSES 中合法的 paid → refunded 流转也被 DB 层拒绝(第一次退款即报错)。
-- 原意是"禁止篡改已支付订单的支付事实",本迁移收窄拦截面:仅支付事实字段不可变,
-- status 允许流向 refunded;DELETE 仍然全禁(append-only 语义不变)。
CREATE OR REPLACE FUNCTION orders_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'orders payment facts are immutable after payment';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_no_delete ON orders;

-- 支付事实字段不可变(金额/档位/周期/商户单号/渠道/归属),防止已支付行被改账
CREATE TRIGGER orders_paid_facts_immutable
  BEFORE UPDATE ON orders
  FOR EACH ROW
  WHEN (OLD.status = 'paid' AND (
    NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.plan IS DISTINCT FROM OLD.plan
    OR NEW.period IS DISTINCT FROM OLD.period
    OR NEW.out_trade_no IS DISTINCT FROM OLD.out_trade_no
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
  ))
  EXECUTE FUNCTION orders_block_mutation();

-- 已支付行仍不可删除
CREATE TRIGGER orders_no_delete
  BEFORE DELETE ON orders
  FOR EACH ROW
  WHEN (OLD.status = 'paid')
  EXECUTE FUNCTION orders_block_mutation();
