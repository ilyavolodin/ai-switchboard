import { Button } from './Button.js';
import styles from './LoadMore.module.css';

export interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  label?: string;
}

export function LoadMore({ hasMore, loading, onLoadMore, label = 'Load more' }: LoadMoreProps) {
  if (!hasMore) return null;
  return (
    <div className={styles.row}>
      <Button variant="outline" size="sm" loading={loading} onClick={onLoadMore}>
        {label}
      </Button>
    </div>
  );
}
