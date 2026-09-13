import { Controller, Get, Inject, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { creditLedger } from '@geo/db';
import { currentAccount } from '../common/auth';
import { DB } from '../common/infra.module';

/** 账户与套餐(docs/01 §3.10):配额分池条 + 积分余额与流水。 */
@Controller('account')
export class AccountController {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  @Get('credits')
  async credits(@Req() req: Request) {
    const accountId = currentAccount(req).accountId;
    const rows = await this.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.accountId, accountId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(100);
    const balance = rows[0]?.balanceAfter ?? 0;
    return { balance, ledger: rows };
  }

  /** 充值下单占位(P2 支付对接;此处仅生成订单语义)。 */
  @Post('credits:purchase')
  purchase(@Param('amount', ParseIntPipe) _amount: number) {
    void _amount;
    return { status: 'not_available', note: '支付对接 P2 上线;所有积分入口显式标价(docs/research 03 A10 对策)' };
  }
}
