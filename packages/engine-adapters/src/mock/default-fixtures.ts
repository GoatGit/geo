import { WEB_ENGINES, type EngineId } from '@geo/shared';
import type { MockFixture } from './mock-adapter';

/**
 * 内置 Mock 回放集:同一问题在不同引擎返回不同位次(对应 docs/research 02 §5.2
 * 的真实分布形态:品牌词统治、泛推荐词分化),供 dev/CI 全链路与口径测试使用。
 */
export function buildDefaultFixtures(): MockFixture[] {
  const out: MockFixture[] = [];

  const scenarios: Record<
    EngineId,
    { ranked: string[]; prose?: string; citations: Array<{ url: string; title?: string }> }
  > = {
    doubao: {
      ranked: ['小米 SU7', '比亚迪海豹', '特斯拉 Model 3', '极氪 001', '小鹏 P7'],
      prose: '其中小米 SU7 的热度与交付量表现突出。',
      citations: [
        { url: 'https://www.dongchedi.com/article/9001', title: '20 万级纯电轿车横评' },
        { url: 'https://www.douyin.com/video/7001', title: 'SU7 动态试驾' },
      ],
    },
    deepseek: {
      ranked: ['比亚迪海豹', '小米 SU7', '特斯拉 Model 3', '极氪 001', '智界 S7'],
      citations: [
        { url: 'https://www.zhihu.com/question/5001', title: '20 万预算买什么纯电轿车' },
        { url: 'https://www.autohome.com.cn/news/9002', title: '海豹 vs SU7 对比' },
      ],
    },
    wenxin: {
      ranked: ['特斯拉 Model 3', '比亚迪汉 EV', '小米 SU7', '小鹏 P7', '极氪 001'],
      citations: [
        { url: 'https://baijiahao.baidu.com/s?id=9003', title: '纯电轿车推荐榜单' },
        { url: 'https://www.yiche.com/xinche/9004', title: 'Model 3 与国产新势力' },
      ],
    },
    qwen: {
      ranked: ['小米 SU7', '特斯拉 Model 3', '比亚迪海豹', '深蓝 SL03', '零跑 C01'],
      prose: '同时小米汽车另有 YU7 在 SUV 序列,本榜单仅讨论轿车。',
      citations: [
        { url: 'https://www.dongchedi.com/article/9005', title: '纯电轿车怎么选' },
      ],
    },
    yuanbao: {
      ranked: ['比亚迪海豹', '极氪 001', '特斯拉 Model 3', '小鹏 P7+', '小米SU7 Ultra'],
      citations: [
        { url: 'https://new.qq.com/rain/a/9006', title: '微信生态热议车型' },
        { url: 'https://www.xiaomiev.com/su7-ultra', title: '小米SU7 Ultra 官网' },
      ],
    },
  };

  for (const engine of WEB_ENGINES) {
    const sc = scenarios[engine];
    const lines = [
      '在 20 万左右的预算内,以下纯电轿车值得考虑:',
      '',
      ...sc.ranked.map((name, i) => `${i + 1}. ${name}`),
      '',
      ...(sc.prose ? [sc.prose, ''] : []),
      '以上信息综合自公开资料,建议到店试驾后再做决定。',
    ];
    out.push({
      engine,
      answerMarkdown: lines.join('\n'),
      citations: sc.citations,
    });

    // 口碑场景(口碑词问题):按引擎差异化措辞/情感/引用,证据样本有区分度
    for (const f of REPUTATION_FIXTURES[engine] ?? []) out.push(f);

    // 空回答态(ok_empty,docs/02 §1.1)
    out.push({
      engine,
      status: 'ok_empty',
      answerMarkdown: '',
      citations: [],
    });
  }

  return out;
}

/**
 * 口碑 fixtures(按引擎措辞与情感倾向差异化:豆包/深求正面、文心中性、千问偏负、元宝生态视角)。
 * 情感用词与 worker 抽取词库一致,确保印象词/情感分布有区分度。
 */
const REPUTATION_FIXTURES: Record<EngineId, MockFixture[]> = {
  doubao: [
    {
      engine: 'doubao',
      kind: 'reputation',
      answerMarkdown: [
        '综合公开讨论,小米汽车的口碑整体偏正面:',
        '做工与质感被普遍认为有竞争力,车机生态联动是一大亮点,智能化体验领先;',
        '主要槽点是部分门店售后服务响应慢,以及价格波动带来的保值顾虑。',
        '总体而言值得推荐。',
      ].join('\n'),
      citations: [{ url: 'https://www.douyin.com/video/7301', title: '车主口碑实测视频' }],
    },
  ],
  deepseek: [
    {
      engine: 'deepseek',
      kind: 'reputation',
      answerMarkdown: [
        '小米汽车口碑分析(基于公开舆情):',
        '优势——做工扎实、生态联动领先,性价比口碑好;',
        '争议——售后网络覆盖不足,部分用户反馈交付与响应较慢。',
        '舆情以正面为主,服务体验是主要槽点。',
      ].join('\n'),
      citations: [{ url: 'https://www.zhihu.com/question/5100', title: '小米汽车口碑怎么样' }],
    },
  ],
  wenxin: [
    {
      engine: 'wenxin',
      kind: 'reputation',
      answerMarkdown: [
        '综合车主反馈,小米汽车的口碑褒贬均有:',
        '产品做工与智能座舱获得认可,生态体验是亮点;',
        '负面主要集中在售后响应偏慢与保值顾虑,质量口碑整体平稳。',
      ].join('\n'),
      citations: [{ url: 'https://baijiahao.baidu.com/s?id=9100', title: '小米汽车车主真实反馈' }],
    },
  ],
  qwen: [
    {
      engine: 'qwen',
      kind: 'reputation',
      answerMarkdown: [
        '小米汽车的口碑目前存在一定争议:',
        '车机生态与做工是公认的亮点,但近期投诉集中在售后服务响应慢、门店体验参差,保值顾虑较多;',
        '建议到店试驾对比后再做决定。',
      ].join('\n'),
      citations: [{ url: 'https://www.toutiao.com/article/9200', title: '小米汽车服务体验讨论' }],
    },
  ],
  yuanbao: [
    {
      engine: 'yuanbao',
      kind: 'reputation',
      answerMarkdown: [
        '腾讯元宝综合微信生态讨论:小米汽车口碑热度高,',
        '生态互联互通被广泛认为领先,做工出色,车主推荐意愿强;',
        '少数用户提及售后响应慢与价格偏贵的问题,整体口碑偏好。',
      ].join('\n'),
      citations: [{ url: 'https://new.qq.com/rain/a/9300', title: '微信生态热议:小米汽车口碑' }],
    },
  ],
};
