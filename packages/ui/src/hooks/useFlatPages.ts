import { useMemo } from 'react';

export interface PagedData<T> {
  pages: { items: T[] }[];
}

export function flatPages<T>(data: PagedData<T> | undefined): T[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

export function useFlatPages<T>(query: { data?: PagedData<T> | undefined }): T[] {
  const { data } = query;
  return useMemo(() => flatPages(data), [data]);
}
