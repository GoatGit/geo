-- 0003 会员订阅支付(docs/02 §7 商业化,docs/01 §3.10 账户与套餐):
-- orders 为支付事实与对账依据(流水全量留存,语义同 credit_ledger 的 append-only 诉求)。
CREATE TABLE orders (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  out_trade_no    text NOT NULL UNIQUE,
  account_id      bigint NOT NULL REFERENCES accounts(id),
  product         text NOT NULL DEFAULT 'plan' CHECK (product IN ('plan')),
  plan            text NOT NULL,
  period          text NOT NULL CHECK (period IN ('monthly', 'yearly')),
  channel         text NOT NULL CHECK (channel IN ('wechat', 'alipay', 'mock')),
  amount_cents    integer NOT NULL,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'refunded', 'expired')),
  channel_trade_id text,
  pay_url         text,
  paid_at         timestamptz,
  expire_at       timestamptz,
  meta            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_account_idx ON orders(account_id, created_at DESC);

-- 订单支付成功后不可回退为中间态(refund 走独立状态流转,禁止 delete/update 已支付金额)
CREATE OR REPLACE FUNCTION orders_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'orders is append-only after payment';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_no_delete BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW WHEN (OLD.status = 'paid') EXECUTE FUNCTION orders_block_mutation();
