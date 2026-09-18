-- 品牌资料库(docs/01 IA ④ 对标竞品品牌库):文本/链接资料,供 AI 写稿/问答/洞察调用。
-- kind: 'text'(粘贴文本)| 'url'(链接,content 存 URL);source: 'manual'(手动)| 'dig'(AI 品牌挖掘产物)。
create table if not exists brand_materials (
  id bigserial primary key,
  brand_id bigint not null references brands(id) on delete cascade,
  kind text not null,
  title text not null,
  content text not null default '',
  source text not null default 'manual',
  byte_len integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists brand_materials_brand_idx on brand_materials(brand_id);
