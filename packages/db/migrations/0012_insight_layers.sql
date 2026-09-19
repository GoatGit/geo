-- 0012 行业洞察精品化(对标竞品方法论):问题语义分层 + 报告披露字段。
-- layer 取值(用户可见标签,直接存中文):消费功能层 / 场景人群层 / 品类行业层 / 竞品层 / 渠道市场层;
-- null = 未分层(不参与分层图表)。披露 = 报告尾部的利益/偏向声明(信任层)。
alter table insight_questions add column if not exists layer text;
alter table industry_insights add column if not exists disclosure text;
