// Components never call `Date.now()` during render (React's purity rule); they read the time
// through `useNow()` or `now()`, which tests pin with `setClock`.
let source: () => number = () => Date.now();

export function now(): number {
  return source();
}

/** Returns a function that restores the previous clock. */
export function setClock(fn: () => number): () => void {
  const previous = source;
  source = fn;
  return () => {
    source = previous;
  };
}
