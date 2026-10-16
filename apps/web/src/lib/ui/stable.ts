/**
 * Returns a function that hands back the previous array while the new one has the same items.
 * Deriveds that build arrays would otherwise change on every model notification and redraw
 * everything that reads them.
 */
export function stableList<T>(): (next: readonly T[]) => T[] {
  let prev: T[] = [];
  return (next) => {
    if (next.length === prev.length && next.every((x, i) => x === prev[i])) return prev;
    return (prev = [...next]);
  };
}
