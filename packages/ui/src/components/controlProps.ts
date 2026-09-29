/**
 * The contract every value control shares, so a `<Field>`'s ids spread straight in and forms can
 * swap one control for another. `onChange` gets the next value, not an event.
 */
export interface ControlProps<T> {
  value: T;
  onChange: (next: T) => void;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}
