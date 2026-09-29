import type { ReactNode } from 'react';

import { Button } from '../../components/Button.js';

export function AddItemButton({
  onClick,
  disabled,
  disabledReason,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        icon="plus"
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={onClick}
      >
        {children}
      </Button>
    </div>
  );
}
