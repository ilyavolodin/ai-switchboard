import { useToast } from '../hooks/toast.js';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';

export interface CopyButtonProps {
  value: string;
  label: string;
  /** Shows `label` as a text button instead of an icon with a tooltip. */
  text?: boolean;
  copiedMessage?: string;
}

export function CopyButton({
  value,
  label,
  text = false,
  copiedMessage = 'Copied',
}: CopyButtonProps) {
  const toast = useToast();
  const copy = () => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        toast({ tone: 'ok', title: copiedMessage });
      })
      .catch(() => {
        toast({ tone: 'error', title: 'Could not copy', detail: value });
      });
  };
  if (text) {
    return (
      <Button variant="outline" icon="copy" onClick={copy}>
        {label}
      </Button>
    );
  }
  return <IconButton icon="copy" label={label} variant="ghost" onClick={copy} />;
}
