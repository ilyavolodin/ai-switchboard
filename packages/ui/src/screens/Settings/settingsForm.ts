import type { GlobalSettings, RetentionSettings } from '@ai-switchboard/core/contract';

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

/**
 * What a section's form would save (`patch`, empty when nothing changed) and what stops it,
 * keyed by form field.
 */
export interface SectionCheck<F> {
  patch: Partial<GlobalSettings>;
  errors: Partial<Record<keyof F, string>>;
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

export function parseDomains(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
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

const MINUTES = 'Enter a whole number of minutes';

export function checkGeneral(saved: GeneralDraft, form: GeneralForm): SectionCheck<GeneralForm> {
  const staleness = parsePositiveInt(form.staleness);
  const silence = parsePositiveInt(form.silence);
  const timezone = form.timezone.trim();
  const errors: SectionCheck<GeneralForm>['errors'] = {};
  if (timezone === '') errors.timezone = 'A timezone is required';
  if (staleness == null) errors.staleness = MINUTES;
  if (silence == null) errors.silence = MINUTES;
  const patch = changedFields(saved, {
    timezone: timezone || saved.timezone,
    defaultQuietHours: form.quiet,
    meterStalenessMinutes: staleness ?? saved.meterStalenessMinutes,
    sourceSilenceMinutes: silence ?? saved.sourceSilenceMinutes,
    systemNotifierId: form.notifier === '' ? null : form.notifier,
    requireReasons: form.requireReasons,
  });
  return { patch, errors };
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

/** Retention saves as one object, so a change sends every limit. */
export function checkRetention(
  saved: RetentionSettings,
  form: RetentionForm,
): SectionCheck<RetentionForm> {
  const errors: SectionCheck<RetentionForm>['errors'] = {};
  const next = { ...saved };
  for (const key of Object.keys(saved) as (keyof RetentionSettings)[]) {
    const n = parsePositiveInt(form[key]);
    if (n == null) errors[key] = 'Enter a whole number of days';
    else next[key] = n;
  }
  const changed = Object.keys(changedFields(saved, next)).length > 0;
  return { patch: changed ? { retention: next } : {}, errors };
}

export interface SignInForm {
  issuer: string;
  clientId: string;
  domains: string;
  trustUnverifiedEmail: boolean;
}

type Oidc = GlobalSettings['oidc'];

export function signInForm(oidc: Oidc): SignInForm {
  return {
    issuer: oidc?.issuer ?? '',
    clientId: oidc?.clientId ?? '',
    domains: (oidc?.allowedDomains ?? []).join(', '),
    trustUnverifiedEmail: oidc?.trustUnverifiedEmail === true,
  };
}

/** Clearing both the issuer and the client id turns OIDC off. An absent trust flag means off. */
export function signInSettings(form: SignInForm): Oidc {
  const issuer = form.issuer.trim();
  const clientId = form.clientId.trim();
  if (issuer === '' && clientId === '') return null;
  const settings = { issuer, clientId, allowedDomains: parseDomains(form.domains) };
  return form.trustUnverifiedEmail ? { ...settings, trustUnverifiedEmail: true } : settings;
}

export function checkSignIn(saved: Oidc, form: SignInForm): SectionCheck<SignInForm> {
  const next = signInSettings(form);
  const errors: SectionCheck<SignInForm>['errors'] = {};
  if (next?.issuer === '') errors.issuer = 'An issuer is required with a client id';
  else if (next && !next.issuer.startsWith('https://')) {
    errors.issuer = 'The issuer must be an https:// URL';
  }
  if (next?.issuer && next.clientId === '') {
    errors.clientId = 'A client id is required with an issuer';
  }
  const changed =
    JSON.stringify(next) !== JSON.stringify(saved && signInSettings(signInForm(saved)));
  return { patch: changed ? { oidc: next } : {}, errors };
}
