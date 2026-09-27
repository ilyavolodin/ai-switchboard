import type { PipelineDots as PipelineDotsDTO, StatusTone } from '@ai-switchboard/core/contract';

import { cx } from '../lib/cx.js';
import { PIPELINE_STOPS } from '../lib/pipeline.js';
import { toneVars } from '../lib/tone.js';
import styles from './PipelineDots.module.css';

const TONE_WORDS: Record<StatusTone, string> = {
  ok: 'ok',
  warn: 'stopped (held or throttled)',
  error: 'error',
  off: 'quiet',
};

export interface PipelineDotsProps {
  dots: PipelineDotsDTO;
  /** sm 6 px (legend), md 8 px (nodes), lg 10 px (process cards). */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * The last hour as five dots — matched › batched › gated › invoked › ok — each coloured by its
 * tone; a quiet stop is a hollow ring. The accessible label reads every stop with its count.
 */
export function PipelineDots({ dots, size = 'md' }: PipelineDotsProps) {
  const px = size === 'sm' ? 6 : size === 'lg' ? 10 : 8;
  const label = PIPELINE_STOPS.map(
    (stop, i) => `${stop} ${dots[stop]} ${TONE_WORDS[dots.tones[i] ?? 'off']}`,
  ).join(', ');
  return (
    <span
      role="img"
      aria-label={`Last hour: ${label}`}
      title="matched › batched › gated › invoked › ok"
      className={cx(styles.dots, size === 'sm' && styles.sm, size === 'lg' && styles.lg)}
    >
      {PIPELINE_STOPS.map((stop, i) => {
        const tone = dots.tones[i] ?? 'off';
        return (
          <span
            key={stop}
            data-stop={stop}
            data-tone={tone}
            className={cx(styles.dot, tone === 'off' && styles.hollow)}
            style={{ width: px, height: px, background: toneVars(tone).fill }}
          />
        );
      })}
    </span>
  );
}
