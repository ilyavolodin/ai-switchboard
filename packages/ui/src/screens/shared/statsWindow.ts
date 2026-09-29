import type { StatsWindow } from '@ai-switchboard/core/contract';

export const WINDOW_LABEL: Record<StatsWindow, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
};

export const WINDOW_OPTIONS: { value: StatsWindow; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];
