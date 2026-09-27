/**
 * 人口地图权威基准(国内公开权威数据,0019):
 * - 国家统计局《中华人民共和国 2023 年国民经济和社会发展统计公报》(2024-02-29)
 * - 国家统计局《第七次全国人口普查公报》(2021-05-11)
 * - 城市分层:第一财经·新一线城市研究所《2020 城市商业魅力排行榜》× 七普分城市常住人口(占比为推导值)
 * 仅收录有官方出处的数字;无官方口径的维度如实标注,不编造。
 */
export interface PopulationBenchmarkCard {
  key: string;
  title: string;
  unit: string;
  rows: Array<{ value: string; share: number; note?: string }>;
}

export const POPULATION_BENCHMARK_SOURCE =
  '国家统计局:2023 年统计公报、第七次全国人口普查公报;城市分层:第一财经 2020 城市商业魅力排行榜×七普';

export const POPULATION_BENCHMARK: { source: string; dimensions: PopulationBenchmarkCard[] } = {
  source: POPULATION_BENCHMARK_SOURCE,
  dimensions: [
    {
      key: 'gender', title: '性别构成', unit: '占总人口',
      rows: [
        { value: '男', share: 73211 / 140967, note: '73,211 万人' },
        { value: '女', share: 67756 / 140967, note: '67,756 万人' },
      ],
    },
    {
      key: 'age', title: '年龄结构(七普)', unit: '占总人口',
      rows: [
        { value: '0-14 岁', share: 0.1795, note: '25,338 万人' },
        { value: '15-59 岁', share: 0.6335, note: '89,438 万人' },
        { value: '60-64 岁', share: 0.052, note: '60 岁及以上 18.70% 中的 60-64 段(推导)' },
        { value: '65 岁及以上', share: 0.135, note: '约 19,064 万人' },
      ],
    },
    {
      key: 'education', title: '受教育程度(七普)', unit: '占总人口',
      rows: [
        { value: '大学(大专及以上)', share: 0.155, note: '21,836 万人' },
        { value: '高中(含中专)', share: 0.151, note: '21,305 万人' },
        { value: '初中', share: 0.345, note: '48,716 万人' },
        { value: '小学', share: 0.248, note: '34,966 万人' },
        { value: '未列明', share: 0.101, note: '含未上过学等' },
      ],
    },
    {
      key: 'urbanRural', title: '城乡结构(2023)', unit: '常住人口',
      rows: [
        { value: '城镇', share: 0.662, note: '93,267 万人,城镇化率 66.2%' },
        { value: '乡村', share: 0.338, note: '47,700 万人' },
      ],
    },
    {
      key: 'cityTier', title: '城市分层(社会通用口径×七普)', unit: '占全国人口(推导)',
      rows: [
        { value: '一线城市(4 城)', share: 8294 / 141178, note: '北上广深,七普 8,294 万' },
        { value: '新一线城市(15 城)', share: 18719 / 141178, note: '七普 18,719 万' },
        { value: '二线及以下(其余城市与乡村)', share: 114165 / 141178, note: '约 11.4 亿(推导余项)' },
      ],
    },
    {
      key: 'income', title: '居民收入(五等份,2023)', unit: '各组人口占 20%',
      rows: [
        { value: '低收入组', share: 0.2, note: '人均可支配收入 9,215 元' },
        { value: '中间偏下组', share: 0.2, note: '20,442 元' },
        { value: '中间收入组', share: 0.2, note: '32,195 元' },
        { value: '中间偏上组', share: 0.2, note: '50,220 元' },
        { value: '高收入组', share: 0.2, note: '95,055 元' },
      ],
    },
    {
      key: 'employment', title: '就业结构(2023)', unit: '就业人员三次产业构成',
      rows: [
        { value: '第一产业', share: 0.228 },
        { value: '第二产业', share: 0.291 },
        { value: '第三产业', share: 0.481 },
      ],
    },
  ],
};

/** 压缩成一行的人物合成上下文:让 LLM 合成的人物属性贴合真实人口结构。 */
export function populationBenchmarkContext(): string {
  return POPULATION_BENCHMARK.dimensions
    .map(d => `${d.title}:${d.rows.map(r => `${r.value}${(r.share * 100).toFixed(1)}%`).join('/')}`)
    .join(';');
}
