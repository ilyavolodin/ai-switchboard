import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/** An empty value, or the fallback, removes the key so shared links stay short. */
export function withParam(
  params: URLSearchParams,
  key: string,
  value: string | null,
  fallback = '',
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value == null || value === '' || value === fallback) next.delete(key);
  else next.set(key, value);
  return next;
}

export function useSearchParamState(
  key: string,
  fallback = '',
): [string, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (next: string | null) => {
      setParams((prev) => withParam(prev, key, next, fallback), { replace: true });
    },
    [setParams, key, fallback],
  );
  return [value, set];
}
