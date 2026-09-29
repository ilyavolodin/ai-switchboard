import type { GlobalSettings, RetentionSettings, Role } from '@ai-switchboard/core/contract';
import { roleAtLeast } from '@ai-switchboard/core/domain';

import { passwordError } from '../shared/passwordRules.js';

export function timezones(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return list;
  } catch {
    // Older engines: fall through to the short list.
  }
  return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin'];
}

export type GeneralDraft = Pick<
  GlobalSettings,
  | 'timezone'
  | 'defaultQuietHours'
  | 'meterStalenessMinutes'
  | 'sourceSilenceMinutes'
  | 'systemNotifierId'
  | 'requireReasons'
>;

export function generalDraft(s: GlobalSettings): GeneralDraft {
  return {
    timezone: s.timezone,
    defaultQuietHours: s.defaultQuietHours,
    meterStalenessMinutes: s.meterStalenessMinutes,
    sourceSilenceMinutes: s.sourceSilenceMinutes,
    systemNotifierId: s.systemNotifierId,
    requireReasons: s.requireReasons,
  };
}

export interface GeneralForm {
  timezone: string;
  quiet: GeneralDraft['defaultQuietHours'];
  staleness: string;
  silence: string;
  notifier: string;
  requireReasons: boolean;
}

export function generalForm(d: GeneralDraft): GeneralForm {
  return {
    timezone: d.timezone,
    quiet: d.defaultQuietHours,
    staleness: String(d.meterStalenessMinutes),
    silence: String(d.sourceSilenceMinutes),
    notifier: d.systemNotifierId ?? '',
    requireReasons: d.requireReasons,
  };
}

export type RetentionForm = Record<keyof RetentionSettings, string>;

export function retentionForm(r: RetentionSettings): RetentionForm {
  return {
    eventsDays: String(r.eventsDays),
    rawBodiesDays: String(r.rawBodiesDays),
    dispatchesDays: String(r.dispatchesDays),
    meterReadingsDays: String(r.meterReadingsDays),
    statsHourlyDays: String(r.statsHourlyDays),
  };
}

export function changedFields<T extends object>(saved: T, draft: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(draft[key])) out[key] = draft[key];
  }
  return out;
}

export function parsePositiveInt(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

export function grantableRoles(own: Role): Role[] {
  return (['viewer', 'operator', 'admin'] as const).filter((r) => roleAtLeast(own, r));
}

export function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function parseDomains(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export interface NewUserCheck {
  email: string;
  emailError: string | null;
  passwordError: string | null;
}

/** Normalises the email and checks it; an empty password means "no password" and is allowed. */
export function checkNewUser(email: string, password: string): NewUserCheck {
  const value = email.trim().toLowerCase();
  return {
    email: value,
    emailError: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'Enter an email address',
    passwordError: password === '' ? null : passwordError(password, value),
  };
}
