/**
 * The UI's one source of "now". Components never call `Date.now()` during render (React's purity
 * rule); they read the time through `useNow()` or this function, which tests can pin with
 * `setClock`.
 */
let source: () => number = () => Date.now();

/** Milliseconds since the epoch, from the current clock source. */
export function now(): number {
  return source();
}

/** Replace the clock (tests). Returns a function that restores the previous clock. */
export function setClock(fn: () => number): () => void {
  const previous = source;
  source = fn;
  return () => {
    source = previous;
  };
}
