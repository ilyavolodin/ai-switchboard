import { cx } from '../lib/cx.js';
import type { SuggestionsState } from '../hooks/useSuggestions.js';
import styles from './SuggestionList.module.css';

export function SuggestionList({ state, label }: { state: SuggestionsState; label: string }) {
  if (!state.open) return null;
  return (
    <ul id={state.listId} role="listbox" aria-label={label} className={styles.list}>
      {state.items.map((s, i) => (
        <li
          key={s.value}
          id={`${state.listId}-${String(i)}`}
          role="option"
          aria-selected={i === state.active}
          title={s.detail}
          className={cx(styles.option, i === state.active && styles.active)}
          onMouseDown={(e) => {
            // Keep focus in the input so the pick lands there.
            e.preventDefault();
          }}
          onClick={() => {
            state.pick(i);
          }}
        >
          <span className={styles.value}>{s.value}</span>
          {s.hint && <span className={styles.hint}>{s.hint}</span>}
        </li>
      ))}
    </ul>
  );
}
