import type { Suggestion } from '../lib/suggest.js';
import { rankSuggestions } from '../lib/suggest.js';
import { useSuggestions } from '../hooks/useSuggestions.js';
import styles from './PathInput.module.css';
import { SuggestionList } from './SuggestionList.js';
import { TextField } from './TextField.js';

export interface PathInputProps {
  id?: string;
  describedBy?: string;
  /** Accessible name of the field (for the suggestion list's label). */
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Paths to offer, e.g. `samplePaths(sample)`; empty = a plain text field. */
  paths: Suggestion[];
  placeholder?: string;
  invalid?: boolean;
  changed?: boolean;
  disabled?: boolean;
}

/**
 * A dotted-path field (`body.issue.id`) that suggests the paths of a sample delivery with their
 * example values as you type: arrows move, Enter accepts, Escape closes.
 */
export function PathInput({
  id,
  describedBy,
  label,
  value,
  onChange,
  paths,
  placeholder,
  invalid,
  changed,
  disabled,
}: PathInputProps) {
  const suggest = useSuggestions((s) => {
    onChange(s.value);
  });
  const refresh = (text: string) => {
    if (paths.length === 0) return;
    const ranked = rankSuggestions(paths, text);
    if (ranked.length > 0) suggest.show(ranked);
    else suggest.close();
  };
  return (
    <div className={styles.wrap}>
      <TextField
        id={id}
        role="combobox"
        aria-expanded={suggest.open}
        aria-describedby={describedBy}
        {...suggest.inputProps}
        mono
        invalid={invalid}
        changed={changed}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value);
        }}
        onFocus={() => {
          refresh(value);
        }}
        onBlur={suggest.close}
        onKeyDown={(e) => {
          if (suggest.onKeyDown(e)) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            refresh(value);
          }
        }}
      />
      <SuggestionList state={suggest} label={`Paths for ${label}`} />
    </div>
  );
}
