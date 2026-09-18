import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsObject, IsOptional, Min } from 'class-validator';
import type { InsightAgentSettings } from '@geo/shared';

/** PUT /admin/settings:只允许平台已定义的键;数值一律非负整数(0 = 不限)。 */
export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  schedulerEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  globalDailyRunCap?: number;

  @IsOptional()
  @IsObject()
  engineDailyCaps?: Record<string, number>;

  @IsOptional()
  @IsObject()
  proxyPool?: { enabled: boolean; key: string };

  @IsOptional()
  @IsObject()
  insightAgent?: Partial<InsightAgentSettings>;
}
