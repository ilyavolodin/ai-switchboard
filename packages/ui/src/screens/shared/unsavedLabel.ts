/** "No unsaved changes", "1 unsaved change", "3 unsaved changes". */
export function unsavedLabel(n: number): string {
  if (n === 0) return 'No unsaved changes';
  return `${n} unsaved change${n === 1 ? '' : 's'}`;
}
