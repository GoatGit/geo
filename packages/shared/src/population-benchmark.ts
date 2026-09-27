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
  rows: Array<{ value: string; share: number; note?: string; bar?: number; amount?: number }>;
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
      key: 'income', title: '居民收入(五等份,2023)', unit: '各组人口占 20%,条高按人均收入',
      rows: [
        { value: '低收入组', share: 0.2, bar: 9215 / 95055, amount: 9215, note: '人均可支配收入 9,215 元' },
        { value: '中间偏下组', share: 0.2, bar: 20442 / 95055, amount: 20442, note: '20,442 元' },
        { value: '中间收入组', share: 0.2, bar: 32195 / 95055, amount: 32195, note: '32,195 元' },
        { value: '中间偏上组', share: 0.2, bar: 50220 / 95055, amount: 50220, note: '50,220 元' },
        { value: '高收入组', share: 0.2, bar: 1, amount: 95055, note: '95,055 元' },
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

/**
 * 人口金字塔(七普,《中国人口普查年鉴-2020》表 7-1 全国分年龄、性别的人口,单位:万人)。
 * 各组为常见公开引用值,合计约 139,604 万,与公报全国人口 141,178 万略有出入(年鉴细分表口径),展示时注明。
 */
export const AGE_PYRAMID: Array<{ band: string; male: number; female: number }> = [
  { band: '0-4', male: 4178.8, female: 3609.6 },
  { band: '5-9', male: 4842.7, female: 4202.7 },
  { band: '10-14', male: 4540.1, female: 3982.5 },
  { band: '15-19', male: 7562.9, female: 3529.0 },
  { band: '20-24', male: 8008.7, female: 3730.1 },
  { band: '25-29', male: 9191.1, female: 4353.9 },
  { band: '30-34', male: 10080.8, female: 4793.0 },
  { band: '35-39', male: 9901.3, female: 4717.6 },
  { band: '40-44', male: 9342.9, female: 4510.4 },
  { band: '45-49', male: 10230.9, female: 4994.5 },
  { band: '50-54', male: 12125.6, female: 5964.8 },
  { band: '55-59', male: 11016.7, female: 5454.8 },
  { band: '60-64', male: 7734.7, female: 3867.9 },
  { band: '65-69', male: 8404.5, female: 4283.1 },
  { band: '70-74', male: 4779.6, female: 2458.5 },
  { band: '75-79', male: 3062.3, female: 1562.9 },
  { band: '80-84', male: 1661.1, female: 873.2 },
  { band: '85-89', male: 777.5, female: 413.1 },
  { band: '90-94', male: 274.9, female: 144.0 },
  { band: '95+', male: 92.5, female: 47.0 },
].map(({ band, male, female }) => ({ band, male: Math.round(male * 10) / 10, female: Math.round(female * 10) / 10 }));
