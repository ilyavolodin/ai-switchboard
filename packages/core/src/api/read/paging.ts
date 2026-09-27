/** Opaque cursors: base64url JSON of the last row's sort key. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { t: string; id?: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof parsed.t !== 'string') return null;
    return { t: parsed.t, ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}) };
  } catch {
    return null;
  }
}

export function pageLimit(limit: number | string | undefined, fallback = 50, max = 200): number {
  const n = Number(limit ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
