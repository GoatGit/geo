import type Redis from 'ioredis';

/**
 * 运营告警(docs/14 §94):钉钉/企微 webhook 文本消息,Redis NX+TTL 去重
 * (同类告警 1 小时内只发一次,防止刷屏)。webhook 未配置时静默禁用。
 */
export class Alerter {
  constructor(
    private readonly redis: Redis | null,
    private readonly webhookUrl: string,
    private readonly env = 'prod',
  ) {}

  /** key = 告警去重键;text = 正文;ttlSec = 同键静默窗口。 */
  async alert(key: string, text: string, ttlSec = 3600): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      if (this.redis) {
        const claimed = await this.redis.set(`geo:alert:${key}`, '1', 'EX', ttlSec, 'NX');
        if (claimed !== 'OK') return;
      }
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: `[青柠GEO/${this.env}] ${text}` } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // 告警失败不影响主链路
    }
  }

  async loginExpired(engine: string, profileId: number, hint: string) {
    await this.alert(`login:${engine}`, `引擎「${engine}」登录态失效(档案 #${profileId},${hint})——需人工重新登录,期间该引擎采集暂停`, 1800);
  }

  async breakerTripped(engine: string, fail: number, ok: number) {
    await this.alert(`breaker:${engine}`, `引擎「${engine}」熔断:5 分钟窗口失败 ${fail}/成功 ${ok}——通道异常,请检查风控/账号`, 900);
  }

  async poolExhausted(engine: string) {
    await this.alert(`pool:${engine}:${new Date().toISOString().slice(0, 10)}`, `引擎「${engine}」账号池耗尽(无 available 档案)——今日采集将延迟,请补充账号或登录`, 7200);
  }

  async queueBacklog(depth: number) {
    await this.alert(`backlog:${new Date().toISOString().slice(0, 13)}`, `采集队列积压 ${depth} 个延迟任务——配额/熔断持续阻塞,请检查账号池与引擎健康`, 3600);
  }
}
