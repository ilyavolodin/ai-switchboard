import { Button } from './Button.js';
import { IconButton } from './IconButton.js';
import styles from './StringListInput.module.css';
import { TextField } from './TextField.js';

export interface StringListInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Used for accessible names: "Labels to watch 1". */
  label: string;
  id?: string;
  describedBy?: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}

/** An editable list of strings: one input per item, remove buttons, and "Add". */
export function StringListInput({
  value,
  onChange,
  label,
  id,
  describedBy,
  placeholder,
  disabled,
  mono,
}: StringListInputProps) {
  return (
    <div
      className={styles.list}
      id={id}
      aria-describedby={describedBy}
      role="group"
      aria-label={label}
    >
      {value.length === 0 && <span className={styles.empty}>None yet.</span>}
      {value.map((item, i) => (
        <div key={i} className={styles.item}>
          <TextField
            size="sm"
            mono={mono}
            aria-label={`${label} ${i + 1}`}
            value={item}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => {
              onChange(value.map((v, j) => (j === i ? e.target.value : v)));
            }}
          />
          <IconButton
            icon="close"
            label={`Remove ${label} ${i + 1}`}
            disabled={disabled}
            onClick={() => {
              onChange(value.filter((_, j) => j !== i));
            }}
          />
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          disabled={disabled}
          onClick={() => {
            onChange([...value, '']);
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
