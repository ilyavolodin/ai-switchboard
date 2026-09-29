/** For fixtures and tests, where a missing item is a bug. */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`No element at index ${i}`);
  return v;
}
