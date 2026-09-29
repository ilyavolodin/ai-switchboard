import { Spinner } from '../components/Spinner.js';
import styles from './RouteLoading.module.css';

export function RouteLoading() {
  return (
    <div className={styles.loading}>
      <Spinner size={24} label="Loading" />
    </div>
  );
}
