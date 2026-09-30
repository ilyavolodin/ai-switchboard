import type { Ref, SubmitEvent } from 'react';
import { useNavigate } from 'react-router';

import { traceHref } from '../lib/hrefs.js';
import { SearchInput } from './SearchInput.js';

/** A search box that opens the Activity trace for whatever artifact id is typed. */
export function TraceSearchForm({
  label = 'Trace an artifact',
  placeholder,
  defaultValue,
  shortcut,
  inputRef,
  clearOnSubmit = false,
  mono = true,
  className,
  inputClassName,
}: {
  label?: string;
  placeholder: string;
  defaultValue?: string;
  shortcut?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Empty the box once the trace opens (the top bar's search). */
  clearOnSubmit?: boolean;
  mono?: boolean;
  className?: string;
  inputClassName?: string;
}) {
  const navigate = useNavigate();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const q = new FormData(form).get('trace');
    if (typeof q !== 'string' || q.trim() === '') return;
    void navigate(traceHref(q.trim()));
    if (clearOnSubmit) form.reset();
  };
  return (
    <form role="search" className={className} onSubmit={submit}>
      <SearchInput
        key={defaultValue}
        ref={inputRef}
        name="trace"
        mono={mono}
        className={inputClassName}
        label={label}
        placeholder={placeholder}
        shortcut={shortcut}
        defaultValue={defaultValue}
      />
    </form>
  );
}
