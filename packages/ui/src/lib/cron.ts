import cronstrue from 'cronstrue';

/** Plain-language description of a cron expression ("At 07:00"), or an error message. */
export function describeCron(
  cron: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const trimmed = cron.trim();
  if (!trimmed) return { ok: false, error: 'Enter a cron expression, e.g. 0 7 * * *' };
  try {
    return {
      ok: true,
      text: cronstrue.toString(trimmed, {
        use24HourTimeFormat: true,
        throwExceptionOnParseError: true,
      }),
    };
  } catch (e) {
    return {
      ok: false,
      error: typeof e === 'string' ? e : e instanceof Error ? e.message : 'Invalid cron expression',
    };
  }
}

/** IANA timezones the browser knows, with the common ones first. */
export function timezones(): string[] {
  const common = [
    'UTC',
    'America/New_York',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Tokyo',
  ];
  return [...new Set([...common, ...supportedZones()])];
}

function supportedZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** "Sat 07:00" in the given timezone. */
export function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}
