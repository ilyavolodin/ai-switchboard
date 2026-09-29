import { Button } from './Button.js';

export interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  label?: string;
}

export function LoadMore({ hasMore, loading, onLoadMore, label = 'Load more' }: LoadMoreProps) {
  if (!hasMore) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-3) 0' }}>
      <Button variant="outline" size="sm" loading={loading} onClick={onLoadMore}>
        {label}
      </Button>
    </div>
  );
}
