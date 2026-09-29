import { IconButton } from '../../components/IconButton.js';
import { useToast } from '../../hooks/toast.js';

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
