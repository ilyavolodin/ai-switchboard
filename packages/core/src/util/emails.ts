export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately loose: one `@` with something on both sides. */
export function isEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(email);
}

/** Emails are short, so the quadratic table is fine. */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Best first: a small edit distance on the whole address or its local part, the same local part
 * at another domain, or (when nothing is closer) the same domain.
 */
export function closeEmails(email: string, candidates: readonly string[], limit = 5): string[] {
  const wanted = normaliseEmail(email);
  const [local = '', domain = ''] = wanted.split('@');
  const scored: { email: string; score: number }[] = [];
  for (const c of candidates) {
    const [cLocal = '', cDomain = ''] = c.split('@');
    const whole = levenshtein(wanted, c);
    const localDistance = levenshtein(local, cLocal);
    const tolerance = Math.max(2, Math.floor(wanted.length / 4));
    let score: number | undefined;
    if (whole <= tolerance) score = whole;
    else if (local !== '' && localDistance <= Math.max(1, Math.floor(local.length / 4)))
      score = 10 + localDistance;
    else if (domain !== '' && cDomain === domain) score = 20 + localDistance;
    if (score !== undefined) scored.push({ email: c, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.email.localeCompare(b.email))
    .slice(0, limit)
    .map((s) => s.email);
}
