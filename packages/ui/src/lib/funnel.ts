import type { FunnelResponse, StatusTone } from '@ai-switchboard/core/contract';

export interface FunnelSegment {
  id: string;
  label: string;
  count: number;
  /** 0–1. */
  share: number;
  /** A CSS colour token. */
  color: string;
  tone?: StatusTone;
}

export interface FunnelStage {
  id: 'matched' | 'deduped' | 'batched' | 'invoked' | 'outcome';
  label: string;
  count: number;
  /** Relative to the largest stage, 0–1. */
  size: number;
  segments: FunnelSegment[];
}

export interface FunnelModel {
  stages: FunnelStage[];
  gate: { held: number; throttled: number };
  sweeps: number;
}

function segments(parts: Omit<FunnelSegment, 'share'>[]): FunnelSegment[] {
  const total = parts.reduce((n, p) => n + p.count, 0);
  return parts
    .filter((p) => p.count > 0)
    .map((p) => ({ ...p, share: total > 0 ? p.count / total : 0 }));
}

export function funnelModel(f: FunnelResponse): FunnelModel {
  const invoked = f.event.invoked + f.sweep.invoked;
  const ok = f.event.ok + f.sweep.ok;
  const error = f.event.error + f.event.failed + f.sweep.error;
  const outcome = ok + error + f.event.unknown + f.event.running;
  // `event.deduped` counts the dispatches dropped as duplicates; the stage shows what remains.
  const afterDedupe = Math.max(0, f.event.matched - f.event.deduped);
  const raw: Omit<FunnelStage, 'size'>[] = [
    {
      id: 'matched',
      label: 'events matched',
      count: f.event.matched,
      segments: segments([
        { id: 'matched', label: 'matched', count: f.event.matched, color: 'var(--primary)' },
      ]),
    },
    {
      id: 'deduped',
      label: 'after dedupe',
      count: afterDedupe,
      segments: segments([
        { id: 'deduped', label: 'after dedupe', count: afterDedupe, color: 'var(--primary)' },
      ]),
    },
    {
      id: 'batched',
      label: 'batches',
      count: f.event.batches,
      segments: segments([
        { id: 'batches', label: 'batches', count: f.event.batches, color: 'var(--primary)' },
      ]),
    },
    {
      id: 'invoked',
      label: 'invoked',
      count: invoked,
      segments: segments([
        { id: 'event', label: 'event runs', count: f.event.invoked, color: 'var(--primary)' },
        { id: 'sweep', label: 'sweeps', count: f.sweep.invoked, color: 'var(--sky)' },
      ]),
    },
    {
      id: 'outcome',
      label: 'outcomes',
      count: outcome,
      segments: segments([
        { id: 'ok', label: 'ok', count: ok, color: 'var(--st-ok)', tone: 'ok' },
        { id: 'error', label: 'error', count: error, color: 'var(--st-err)', tone: 'error' },
        {
          id: 'unknown',
          label: 'unknown',
          count: f.event.unknown,
          color: 'var(--st-warn)',
          tone: 'warn',
        },
        {
          id: 'running',
          label: 'running',
          count: f.event.running,
          color: 'var(--st-off)',
          tone: 'off',
        },
      ]),
    },
  ];
  const max = Math.max(1, ...raw.map((s) => s.count));
  return {
    stages: raw.map((s) => ({ ...s, size: s.count / max })),
    gate: { held: f.event.held + f.sweep.held, throttled: f.event.throttled + f.sweep.throttled },
    sweeps: f.sweep.invoked,
  };
}
