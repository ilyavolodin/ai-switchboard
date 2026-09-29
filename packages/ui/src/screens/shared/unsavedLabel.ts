export function unsavedLabel(n: number): string {
  if (n === 0) return 'No unsaved changes';
  return `${n} unsaved change${n === 1 ? '' : 's'}`;
}
