import type { SecretRefDTO } from '@ai-switchboard/core/contract';
import { useId, useState } from 'react';
import { Link } from 'react-router';

import { useSecretSuggestions } from '../api/hooks/secrets.js';
import { useNow } from '../hooks/useNow.js';
import { formatRelative, toMs } from '../lib/format.js';
import { formatSecretRef, parseSecretRef } from '../lib/schema.js';
import { Icon } from './Icon.js';
import { Select } from './Select.js';
import styles from './SecretRefInput.module.css';
import { TextField } from './TextField.js';

export interface SecretRefInputProps {
  /** `secret://<provider>/<name>`. Anything else is never displayed. */
  value: unknown;
  onChange: (next: string | undefined) => void;
  /** `undefined` while loading; an empty list shows a hint pointing to Settings. */
  providers?: string[];
  status?: SecretRefDTO;
  id?: string;
  describedBy?: string;
  disabled?: boolean;
  invalid?: boolean;
  label?: string;
}

/** Secret values never touch the UI: a stored plain value is not shown, only flagged. */
export function SecretRefInput({
  value,
  onChange,
  providers,
  status,
  id,
  describedBy,
  disabled,
  invalid,
  label = 'Secret',
}: SecretRefInputProps) {
  const nowMs = useNow(60_000);
  const parsed = parseSecretRef(value);
  const [draftProvider, setDraftProvider] = useState<string | undefined>(undefined);
  const known = providers ?? [];
  const provider = parsed?.provider ?? draftProvider ?? known[0] ?? '';
  const noProviders = providers?.length === 0 && provider === '';
  const name = parsed?.name ?? '';
  const hasPlainValue = value != null && value !== '' && parsed == null;
  const suggestions = useSecretSuggestions(provider);
  const listId = useId();
  const notListed = suggestions.names != null && name !== '' && !suggestions.names.includes(name);
  const options = (known.includes(provider) || provider === '' ? known : [provider, ...known]).map(
    (p) => ({
      value: p,
      label: p,
    }),
  );

  const emit = (p: string, n: string) => {
    if (p === '') return;
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
          disabled={disabled === true || options.length === 0}
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
          disabled={disabled === true || noProviders}
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
        {noProviders ? (
          <span className={styles.warn}>
            No secret provider is configured.{' '}
            <Link to="/settings/secret-providers">Add one in Settings › Secret providers</Link>
          </span>
        ) : hasPlainValue ? (
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
