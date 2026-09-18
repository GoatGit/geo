import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { platformSettings } from './schema';
import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTING_KEYS,
  mergePlatformSettings,
  type PlatformSettingKey,
  type PlatformSettings,
} from '@geo/shared';

export type SettingsDb = Pick<NodePgDatabase, 'select' | 'insert'>;
export type SettingsWriteDb = Pick<NodePgDatabase, 'select' | 'insert' | 'transaction'>;

/** 读取生效配置:platform_settings 存储值 ∪ 代码默认值(类型净化在 shared)。 */
export async function loadPlatformSettings(db: SettingsDb): Promise<PlatformSettings> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(inArray(platformSettings.key, [...PLATFORM_SETTING_KEYS]));
  return mergePlatformSettings(rows);
}

/** 保存补丁(只写出现的键);updatedBy 为操作管理员账号 id。多键写入单事务:并发读可见半更新配置。 */
export async function savePlatformSettings(
  db: SettingsWriteDb,
  patch: Partial<PlatformSettings>,
  updatedBy?: number,
): Promise<PlatformSettings> {
  const entries = Object.entries(patch).filter(([k]) =>
    (PLATFORM_SETTING_KEYS as readonly string[]).includes(k),
  ) as Array<[PlatformSettingKey, unknown]>;
  if (entries.length === 0) return { ...DEFAULT_PLATFORM_SETTINGS };
  await db.transaction(async (tx) => {
    for (const [key, value] of entries) {
      await tx
        .insert(platformSettings)
        .values({ key, value, updatedBy: updatedBy ?? null, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: { value, updatedBy: updatedBy ?? null, updatedAt: new Date() },
        });
    }
  });
  return loadPlatformSettings(db);
}
