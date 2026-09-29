import type { CronPreviewRequest, CronPreviewResponse } from '../api/contract.js';

import { describeCron, isValidTimezone, nextTicks, parseCron } from './cron.js';

export function cronPreview(req: CronPreviewRequest, now: Date): CronPreviewResponse {
  if (!isValidTimezone(req.timezone)) {
    return { valid: false, description: '', next: [], error: `unknown timezone ${req.timezone}` };
  }
  const parsed = parseCron(req.cron);
  if (!parsed.ok) return { valid: false, description: '', next: [], error: parsed.error };
  const description = describeCron(parsed.cron.source) ?? parsed.cron.source;
  const next = nextTicks(parsed.cron, req.timezone, now, 3).map((d) => d.toISOString());
  return { valid: true, description: `${description} (${req.timezone})`, next };
}
