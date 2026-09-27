import type { SecretRefDTO } from '@ai-switchboard/core/contract';
import { useId, useState } from 'react';

import { useSecretSuggestions } from '../api/hooks/secrets.js';
import { useNow } from '../hooks/useNow.js';
import { formatRelative, toMs } from '../lib/format.js';
import { formatSecretRef, parseSecretRef } from '../lib/schema.js';
import { Icon } from './Icon.js';
import { Select } from './Select.js';
import styles from './SecretRefInput.module.css';
import { TextField } from './TextField.js';

export interface SecretRefInputProps {
  /** The stored value: `secret://<provider>/<name>`. Anything else is never displayed. */
  value: unknown;
  onChange: (next: string | undefined) => void;
  /** Secret provider ids to choose from (default: env, file). */
  providers?: string[];
  /** Resolution status from the API (`SecretRefDTO`), for "resolved 13 h ago". */
  status?: SecretRefDTO;
  id?: string;
  describedBy?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Accessible name prefix, e.g. the field title. */
  label?: string;
}

/**
 * A secret-reference input: provider select + name, stored as `secret://<provider>/<name>`.
 * Secret values never touch the UI: a stored plain value is not shown, only flagged. For admins
 * the name offers the names the chosen provider lists (free typing still works) and flags a
 * name the provider does not list.
 */
export function SecretRefInput({
  value,
  onChange,
  providers = ['env', 'file'],
  status,
  id,
  describedBy,
  disabled,
  invalid,
  label = 'Secret',
}: SecretRefInputProps) {
  const nowMs = useNow(60_000);
  const parsed = parseSecretRef(value);
  const [draftProvider, setDraftProvider] = useState(providers[0] ?? 'env');
  const provider = parsed?.provider ?? draftProvider;
  const name = parsed?.name ?? '';
  const hasPlainValue = value != null && value !== '' && parsed == null;
  const suggestions = useSecretSuggestions(provider);
  const listId = useId();
  const notListed = suggestions.names != null && name !== '' && !suggestions.names.includes(name);
  const options = (providers.includes(provider) ? providers : [provider, ...providers]).map(
    (p) => ({
      value: p,
      label: p,
    }),
  );

  const emit = (p: string, n: string) => {
    onChange(n.trim() ? formatSecretRef(p, n.trim()) : undefined);
  };

  const resolved = toMs(status?.lastResolvedAt);
  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <span className={styles.scheme} aria-hidden="true">
          <Icon name="key" size={12} />
          secret://
        </span>
        <Select
          size="sm"
          className={styles.provider}
          aria-label={`${label} provider`}
          options={options}
          value={provider}
          disabled={disabled}
          onChange={(e) => {
            setDraftProvider(e.target.value);
            if (name) emit(e.target.value, name);
          }}
        />
        <span className={styles.scheme} aria-hidden="true">
          /
        </span>
        <TextField
          id={id}
          size="sm"
          mono
          className={styles.name}
          aria-label={id ? undefined : `${label} name`}
          aria-describedby={describedBy}
          invalid={invalid}
          placeholder="SECRET_NAME"
          autoComplete="off"
          spellCheck={false}
          value={name}
          disabled={disabled}
          list={suggestions.names?.length ? listId : undefined}
          onChange={(e) => {
            emit(provider, e.target.value);
          }}
        />
        {suggestions.names && suggestions.names.length > 0 && (
          <datalist id={listId}>
            {suggestions.names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        )}
      </div>
      <span className={styles.caption}>
        {hasPlainValue ? (
          <span className={styles.warn}>
            A value is stored here directly (hidden). Replace it with a reference.
          </span>
        ) : notListed ? (
          <span className={styles.warn}>
            not found in {provider} · check the name or add the secret
          </span>
        ) : status && !status.ok ? (
          <span className={styles.err}>
            could not resolve{status.error ? ` · ${status.error}` : ''}
          </span>
        ) : (
          <>
            secret reference · value never shown
            {resolved != null ? ` · resolved ${formatRelative(resolved, nowMs)}` : ''}
          </>
        )}
      </span>
    </div>
  );
}
