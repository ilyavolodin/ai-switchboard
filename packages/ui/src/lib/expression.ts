/** How many evaluated rows came out true, false and as errors (an error is neither). */
export function evaluationCounts(rows: readonly { result: unknown; error?: string | null }[]): {
  true: number;
  false: number;
  errors: number;
} {
  const counts = { true: 0, false: 0, errors: 0 };
  for (const r of rows) {
    if (r.error) counts.errors++;
    else if (r.result) counts.true++;
    else counts.false++;
  }
  return counts;
}
