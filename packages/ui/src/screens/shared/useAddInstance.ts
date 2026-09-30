import type { UseMutationResult } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useReasonedMutation } from '../../hooks/reason.js';
import { withoutUndefined } from '../../lib/values.js';
import type { InstanceDraft } from './AddInstanceDialog.js';

interface CreateVars<C> {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  caps?: C;
  enabled?: boolean;
  reason: string;
}

export interface AddInstanceInput<C, D extends { id: string; name: string }> {
  noun: 'source' | 'destination';
  mutation: UseMutationResult<D, Error, CreateVars<C>>;
  consequence: string;
  /** Where the new instance opens. */
  href: (id: string) => string;
}

/** The Add dialog's open state and its submit: create enabled, then open the new instance. */
export function useAddInstance<C extends object, D extends { id: string; name: string }>({
  noun,
  mutation,
  consequence,
  href,
}: AddInstanceInput<C, D>) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const create = useReasonedMutation(
    mutation,
    (v: { name: string }) => ({
      title: `Create ${v.name}?`,
      consequence,
      confirmLabel: `Create ${noun}`,
    }),
    { successMessage: (d) => `${d.name} created` },
  );
  return {
    adding,
    open: () => {
      setAdding(true);
    },
    close: () => {
      setAdding(false);
    },
    submit: async ({ type, name, settings, caps }: InstanceDraft<C>): Promise<boolean> => {
      const created = await create.run({
        typeId: type.typeId,
        name,
        settings,
        caps: withoutUndefined(caps),
        enabled: true,
      });
      if (!created) return false;
      setAdding(false);
      void navigate(href(created.id));
      return true;
    },
  };
}
