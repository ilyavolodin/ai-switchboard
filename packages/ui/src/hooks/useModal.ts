import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open modals, innermost last. Only the top one answers Escape and Tab, so a reason prompt opened
 * from a dialog closes alone; global shortcuts stay off while any is open.
 */
const stack: object[] = [];

export function isModalOpen(): boolean {
  return stack.length > 0;
}

export type InitialFocus = 'first-field' | 'container';

function trapTab(e: KeyboardEvent, node: HTMLElement): void {
  const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!first || !last) {
    e.preventDefault();
    node.focus();
    return;
  }
  if (!(active instanceof Node) || !node.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === node)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** The modal element needs `tabIndex={-1}` so it can hold focus when nothing inside can. */
export function useModal(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  initialFocus: InitialFocus = 'first-field',
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const layer = {};
    stack.push(layer);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const target =
      initialFocus === 'first-field'
        ? (node?.querySelector<HTMLElement>('input, textarea, select') ??
          node?.querySelector<HTMLElement>(FOCUSABLE) ??
          node)
        : node;
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== layer) return;
      if (e.key === 'Escape') {
        // An open suggestion list (path field, expression editor) takes Escape first.
        if (e.target instanceof HTMLElement && e.target.dataset.suggestionsOpen === 'true') return;
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && node) {
        trapTab(e, node);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(layer);
      if (i !== -1) stack.splice(i, 1);
      opener?.focus();
    };
  }, [open, ref, initialFocus]);
}
