import { describe, expect, it, vi } from 'vitest';

import { errorText } from './errors.js';
import { isRecord, str } from './guards.js';
import { withTimeout } from './timeout.js';
import { isUuid } from './uuid.js';

describe('util', () => {
  it('errorText reads an Error or stringifies anything else', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(42)).toBe('42');
  });

  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('str keeps non-empty strings', () => {
    expect(str('a')).toBe('a');
    expect(str('')).toBeUndefined();
    expect(str(1)).toBeUndefined();
  });

  it('isUuid matches the canonical form in either case', () => {
    expect(isUuid('0b7c5c1e-6a1f-4f5e-9d7a-3c2b1a0f9e8d')).toBe(true);
    expect(isUuid('0B7C5C1E-6A1F-4F5E-9D7A-3C2B1A0F9E8D')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('withTimeout passes the result through or rejects with the message', async () => {
    await expect(withTimeout(Promise.resolve(1), 1_000, 'slow')).resolves.toBe(1);
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<never>(() => undefined), 5_000, 'slow');
      const outcome = expect(pending).rejects.toThrow('slow');
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
