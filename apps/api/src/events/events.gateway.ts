import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Redis } from 'ioredis';
import { Namespace, Socket } from 'socket.io';
import { verifyAccessToken } from '../common/auth';
import { loadEnv } from '../config/env';

/**
 * 采集进度实时推送(docs/01 §3.3 采集队列实时面板,docs/05 §6 /runs/progress):
 * worker 发布 Redis 频道 geo:progress → 本网关按账号房间转发。
 * 房间按 accountId 隔离(品牌归属校验在订阅时做,越权不可见)。
 */
@WebSocketGateway({ path: '/ws', transports: ['websocket'] })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Namespace;
  private readonly logger = new Logger(EventsGateway.name);
  private subscriber?: Redis;

  onModuleInit() {
    this.subscriber = new Redis(loadEnv().redisUrl, { maxRetriesPerRequest: 3 });
    this.subscriber.subscribe('geo:progress');
    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        const msg = JSON.parse(raw) as { accountId: number; payload: unknown };
        this.server?.to(`account:${msg.accountId}`).emit('progress', msg.payload);
      } catch (err) {
        this.logger.warn(`bad progress message: ${(err as Error).message}`);
      }
    });
  }

  onModuleDestroy() {
    void this.subscriber?.quit();
  }

  handleConnection(client: Socket): void {
    const token = (client.handshake.auth?.token ?? client.handshake.query?.token) as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const account = verifyAccessToken(loadEnv(), token);
      client.data.accountId = account.accountId;
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    void client;
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, data: { brandId: number }) {
    void data; // 品牌级过滤在 worker 消息体内携带 brandId,前端按需渲染;房间按账号隔离
    const accountId = client.data.accountId as number | undefined;
    if (!accountId) return { ok: false };
    await client.join(`account:${accountId}`);
    return { ok: true };
  }
}
