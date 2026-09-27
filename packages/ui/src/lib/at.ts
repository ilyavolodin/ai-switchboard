/** `list[i]`, throwing when it is missing (fixtures and tests, where absence is a bug). */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`No element at index ${i}`);
  return v;
}
