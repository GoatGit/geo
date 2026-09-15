/**
 * 跨进程运行时契约:队列名与 Redis key 由 API 与 Worker 共同读写,
 * 字符串只在此定义一次,任何一侧都不得私写字面量。
 */

export const COLLECT_QUEUE = 'collect';
export const REPUTATION_QUEUE = 'extract-reputation';
export const REPORTS_QUEUE = 'reports';

export const REDIS_PROGRESS_CHANNEL = 'geo:progress';

/** Worker 调度器心跳:scheduler 每 tick 覆写,API 管理后台据此判活。 */
export const WORKER_HEARTBEAT_KEY = 'geo:worker:heartbeat';
/** 心跳判活窗口 = 3 个调度间隔(默认 60s × 3)。 */
export const WORKER_HEARTBEAT_STALE_MS = 180_000;

/** 引擎熔断位:tripped 为自动熔断(5 分钟半开),manual 为管理后台手动暂停(无过期)。 */
export const breakerTrippedKey = (engine: string) => `geo:breaker:tripped:${engine}`;
export const breakerManualKey = (engine: string) => `geo:breaker:manual:${engine}`;

/**
 * 人工登录编排(docs/04 §3.1 账号生命周期:注册/登录态供给由运营完成):
 * API 管理后台把登录请求 LPUSH 进队列,Worker(拥有浏览器)BLPOP 消费并轮询登录态,
 * 状态写 status key 供后台轮询展示。单消费者即可,队列不堆积。
 */
export const LOGIN_REQ_QUEUE = 'geo:login:req';
export const loginStatusKey = (sessionId: string) => `geo:login:status:${sessionId}`;
/** 登录状态 key 保留 1h:后台展示窗口足够,避免 Redis 残留。 */
export const LOGIN_STATUS_TTL_SEC = 3600;

/**
 * 远程登录可视化操控(生产 BROWSER_MODE=agentbay 时浏览器在云端,操作者无法触碰本地窗口):
 * worker 把远程页面截帧(JPEG base64)写 frame key,后台轮询展示;
 * 后台把点击/文字/回车指令 LPUSH 进 cmd 队列,worker 经 CDP 注入远程页面。
 * 本地模式同样适用(无头 + viewer,不再依赖弹窗)。
 */
export const loginFrameKey = (sessionId: string) => `geo:login:frame:${sessionId}`;
export const loginCmdKey = (sessionId: string) => `geo:login:cmd:${sessionId}`;
/** 截帧 key 保留 120s:覆盖后台轮询间隔,避免崩溃残留。 */
export const LOGIN_FRAME_TTL_SEC = 120;

/**
 * 登录取消标记:后台「取消登录」置 '1'(EX 同状态 TTL),worker 轮询循环发现即终止
 * 当前登录并释放远程会话——失败/挂起的登录不必等满超时窗口,不阻塞后续账号排队。
 */
export const loginCancelKey = (sessionId: string) => `geo:login:cancel:${sessionId}`;
export const LOGIN_CANCEL_TTL_SEC = 3600;

/** 后台 → worker 的远程操控指令。 */
export type LoginInputCommand =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string };

/** API → Worker 登录请求载荷。 */
export interface LoginRequest {
  sessionId: string;
  profileId: number;
  engine: string;
  profileKey: string;
  fingerprint: Record<string, unknown>;
  proxyHint: string | null;
  contextRef: string | null;
  requestedAt: string;
}

/** Worker 登录会话状态(后台轮询展示)。 */
export interface LoginStatus {
  state: 'queued' | 'running' | 'done' | 'timeout' | 'error' | 'cancelled';
  detail?: string;
  /** true = viewer 远程操控模式:后台应展示实时画面并转发输入 */
  viewer?: boolean;
  updatedAt: string;
}
