import { plural } from '../../lib/format.js';

export function unsavedLabel(n: number): string {
  if (n === 0) return 'No unsaved changes';
  return plural(n, 'unsaved change');
}
