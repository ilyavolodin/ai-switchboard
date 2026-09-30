import type { CronPreviewResponse } from '@ai-switchboard/core/contract';

import { usePreviewCron } from '../api/hooks/processes.js';
import { useDebounced } from './useDebounced.js';

/** The server's reading of `cron`, or `undefined` while it catches up with the typed text. */
export function useCronPreview(value: {
  cron: string;
  timezone: string;
}): CronPreviewResponse | undefined {
  // Debounce the strings, not `value`: callers often pass a fresh object every render, which
  // would restart the timer on each one.
  const cron = useDebounced(value.cron, 400);
  const timezone = useDebounced(value.timezone, 400);
  const preview = usePreviewCron(cron.trim() ? { cron: cron.trim(), timezone } : null);
  const empty = value.cron.trim() === '';
  return !empty && cron === value.cron && !preview.isPlaceholderData ? preview.data : undefined;
}
