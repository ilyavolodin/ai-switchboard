import type { ReactNode } from 'react';

import { Skeleton } from '../../components/Skeleton.js';
import { LoadFailure } from './LoadFailure.js';

export interface DetailQuery<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/** The loading and "does not exist" states of a detail page; `children` renders the loaded one. */
export function InstanceDetailShell<T>({
  query,
  noun,
  listTo,
  children,
}: {
  query: DetailQuery<T>;
  noun: 'source' | 'destination';
  listTo: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) {
    return <Skeleton shape="card" height={320} label={`Loading the ${noun}`} />;
  }
  if (query.isError || query.data === undefined) {
    return (
      <LoadFailure error={query.error} noun={noun} listTo={listTo} listLabel={`All ${noun}s`} />
    );
  }
  return <>{children(query.data)}</>;
}
