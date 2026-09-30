import { STATS_WINDOWS, type StatsWindow } from '@ai-switchboard/core/domain';

export const WINDOW_LABEL: Record<StatsWindow, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
};

export const WINDOW_OPTIONS: { value: StatsWindow; label: string }[] = STATS_WINDOWS.map((w) => ({
  value: w,
  label: WINDOW_LABEL[w],
}));
