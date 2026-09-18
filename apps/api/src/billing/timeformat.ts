/**
 * 支付渠道时间格式(纯函数,可测):
 * 微信 v3 要求 RFC3339 且时间语义为北京时间(东八区);支付宝 timestamp 要求 GMT+8 空格分隔。
 * 渠道网关对时间偏差敏感:直接把 UTC 串的 Z 换成 +08:00 会整体偏移 8 小时
 * (实测曾导致 time_expire 早于下单时刻,下单即过期),必须先做墙上时间换算。
 */

/** 东八区固定偏移:国内收单渠道无夏令时,用固定偏移即可。 */
const CST_OFFSET_MS = 8 * 3600 * 1000;

/** 把任意可解析时间转为北京时间语义的 RFC3339(如 2026-09-18T14:30:00+08:00)。 */
export function toRfc3339Beijing(input: string | Date): string {
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (Number.isNaN(t)) throw new Error(`invalid datetime: ${String(input)}`);
  // 先加 8h 再取 UTC 各字段,得到的"墙上时间"即北京时刻,再标注 +08:00
  return new Date(t + CST_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

/** 支付宝 timestamp:北京时间,yyyy-MM-dd HH:mm:ss。 */
export function toAlipayTimestamp(now = new Date()): string {
  return new Date(now.getTime() + CST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}
