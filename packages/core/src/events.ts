export type Listener<T> = (event: T) => void;

/** Minimal typed event emitter (no DOM, no Node). */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: T): void {
    for (const l of [...this.listeners]) l(event);
  }
  get size(): number {
    return this.listeners.size;
  }
}
