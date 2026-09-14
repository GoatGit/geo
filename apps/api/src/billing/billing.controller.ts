import { Body, Controller, Get, HttpException, HttpStatus, Param, ParseIntPipe, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsIn } from 'class-validator';
import { BILLING_PERIODS, type BillingPeriod, type PayChannel, type PlanTier } from '@geo/shared';
import { currentAccount, Public } from '../common/auth';
import { BillingService } from './billing.service';

class CreateOrderDto {
  @IsIn(['starter', 'standard', 'pro'])
  plan!: PlanTier;

  @IsIn(BILLING_PERIODS as unknown as string[])
  period!: BillingPeriod;

  @IsIn(['wechat', 'alipay'])
  channel!: Exclude<PayChannel, 'mock'>;
}

/**
 * 会员与支付(docs/01 §3.10 ⑦ 账户与套餐):
 * 目录/下单/查单/账单需登录;渠道异步回调为公开路由(以验签替代鉴权,docs/07 §9)。
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Get('subscription')
  subscription(@Req() req: Request) {
    return this.billing.subscriptionStatus(currentAccount(req).accountId);
  }

  @Post('orders')
  async createOrder(@Req() req: Request, @Body() dto: CreateOrderDto) {
    return this.billing.createOrder(currentAccount(req).accountId, {
      plan: dto.plan,
      period: dto.period,
      channel: dto.channel,
    });
  }

  @Get('orders')
  orders(@Req() req: Request) {
    return this.billing.ordersOf(currentAccount(req).accountId);
  }

  @Get('orders/:id')
  async order(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.billing.orderOf(currentAccount(req).accountId, id);
  }

  /** dev 模拟支付(mock 通道):生产环境显式 410,不提供。 */
  @Post('orders/:id/mock-pay')
  async mockPay(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    if (process.env.NODE_ENV === 'production') {
      throw new HttpException('mock 支付仅限开发环境', HttpStatus.GONE);
    }
    return this.billing.mockPay(currentAccount(req).accountId, id);
  }

  @Public()
  @Post('notify/wechat')
  async wechatNotify(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    const headers: Record<string, string> = {};
    for (const key of ['wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-signature', 'wechatpay-serial']) {
      headers[key] = String(req.headers[key] ?? '');
    }
    const result = await this.billing.handleWechatNotify(headers, (req.rawBody ?? Buffer.from('')).toString('utf8'));
    res.status(result.status).type('json').send(result.body);
  }

  @Public()
  @Post('notify/alipay')
  async alipayNotify(@Req() req: Request, @Res() res: Response) {
    const result = await this.billing.handleAlipayNotify(req.body as Record<string, unknown>);
    res.status(result.status).type('text').send(result.body);
  }
}
