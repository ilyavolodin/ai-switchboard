/** Copy helpers for applying a YAML configuration. */
import type { ApplyResponse, StatusTone } from '@ai-switchboard/core/contract';

/** Tone per change action in the dry-run list. */
export const CHANGE_TONE: Record<ApplyResponse['changes'][number]['action'], StatusTone> = {
  create: 'ok',
  update: 'warn',
  delete: 'error',
  unchanged: 'off',
};

/** "2 to create, 1 to update, 1 to delete" (or "created …" once applied). */
export function applySummary(res: ApplyResponse): string {
  const count = (a: string) => res.changes.filter((c) => c.action === a).length;
  const parts = (
    [
      ['create', 'created'],
      ['update', 'updated'],
      ['delete', 'deleted'],
    ] as const
  )
    .map(([a, done]) => {
      const n = count(a);
      if (n === 0) return null;
      return res.dryRun ? `${n} to ${a}` : `${n} ${done}`;
    })
    .filter((p): p is string => p != null);
  if (parts.length === 0) return 'Nothing changes.';
  return `${parts.join(', ')}. Every change is audited with your reason.`;
}
