import { IconButton } from '../../components/IconButton.js';
import { useToast } from '../../hooks/toast.js';

/** Copies a value (a webhook or callback URL) to the clipboard. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <IconButton
      icon="copy"
      label={label}
      variant="ghost"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            toast({ tone: 'ok', title: 'Copied' });
          })
          .catch(() => {
            toast({ tone: 'error', title: 'Could not copy', detail: value });
          });
      }}
    />
  );
}
