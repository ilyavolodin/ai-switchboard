import type { ReactNode } from 'react';

import { QueryError, type RetryableQuery } from './QueryError.js';

export interface BoundaryQuery<T> extends RetryableQuery {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
}

export interface QueryBoundaryProps<T> {
  query: BoundaryQuery<T>;
  /** What failed, e.g. "Users could not load". */
  errorTitle: string;
  pending: ReactNode;
  /** Shown instead of `children` when `isEmpty(data)`; by default an empty array is empty. */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}

const emptyArray = (data: unknown) => Array.isArray(data) && data.length === 0;

export function QueryBoundary<T>({
  query,
  errorTitle,
  pending,
  empty,
  isEmpty = emptyArray,
  children,
}: QueryBoundaryProps<T>) {
  if (query.isError) return <QueryError query={query} title={errorTitle} />;
  if (query.isPending || query.data === undefined) return <>{pending}</>;
  if (empty !== undefined && isEmpty(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
