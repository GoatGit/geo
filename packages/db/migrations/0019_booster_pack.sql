-- 0019 一次性资源包(docs/02 §7.3):orders.product 扩展 pack 品类
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_product_check;
ALTER TABLE orders ADD CONSTRAINT orders_product_check CHECK (product IN ('plan','pack'));
