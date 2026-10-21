import { eq } from 'drizzle-orm';
import type { DispatchSettings, WorkingTimeRules } from '@merge/shared';
import { DEFAULT_WORKING_TIME_RULES } from '@merge/shared';
import type { Db } from '../db/client.js';
import { platformSettings, type PlatformSettingsRow } from '../db/schema.js';

export function getSettings(db: Db): PlatformSettingsRow {
  const row = db.select().from(platformSettings).where(eq(platformSettings.id, 'default')).get();
  if (!row) throw new Error('Platform settings missing; run migrations');
  return row;
}

export function ensureSettings(db: Db, now: Date): PlatformSettingsRow {
  const existing = db.select().from(platformSettings).where(eq(platformSettings.id, 'default')).get();
  if (existing) return existing;
  db.insert(platformSettings).values({ id: 'default', updatedAt: now }).run();
  return getSettings(db);
}

export function dispatchSettingsFrom(s: PlatformSettingsRow): DispatchSettings {
  return {
    priorityWindowMinutes: s.priorityWindowMinutes,
    agencyWindowMinutes: s.agencyWindowMinutes,
    agencyPosition: s.agencyPosition,
    urgentThresholdMinutes: s.urgentThresholdMinutes,
    minLeadBeforeStartMinutes: s.minLeadBeforeStartMinutes,
    preferredPartnersGetPriority: s.preferredPartnersGetPriority,
  };
}

export function workingTimeRulesFrom(s: PlatformSettingsRow): WorkingTimeRules {
  return {
    ...DEFAULT_WORKING_TIME_RULES,
    minRestHours: s.minRestHours,
    maxWeeklyHours: s.maxWeeklyHours,
    maxShiftHours: s.maxShiftHours,
  };
}
