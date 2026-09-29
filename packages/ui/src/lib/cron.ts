import cronstrue from 'cronstrue';

/**
 * Plain-language text for a cron, or `null` when the describer can't read it. Whether a cron is
 * valid is the server's call (`POST /processes/preview/cron`), not this.
 */
export function describeCron(cron: string): string | null {
  const trimmed = cron.trim();
  if (!trimmed) return null;
  try {
    return cronstrue.toString(trimmed, {
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    });
  } catch {
    return null;
  }
}

/** The common ones first. */
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
