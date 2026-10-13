// Makes the plain model classes of @folio/app readable from Svelte without per-read bookkeeping.
// `live(model)` returns a stable proxy: every property read registers a dependency on the single
// model-change counter, so templates and `$derived` re-evaluate when any model emits `changed`.
// Methods run on the raw object with raw arguments, so models never see a proxy.
import { untrack } from 'svelte';

const state = $state({ v: 0 });
/** Read inside `$derived`/templates to depend on every model change. */
export const track = (): number => state.v;
export const bump = (): void => {
  state.v++;
};
// The page under the viewport changes on every scroll step; it has its own counter so the whole UI
// does not re-evaluate. Read through `raw(session)`: a live proxy would register `state.v` as well.
const pageState = $state({ v: 0 });
export const trackPage = (): number => pageState.v;
export const bumpPage = (): void => {
  pageState.v++;
};

const proxies = new WeakMap<object, object>();
const bridges = new WeakMap<object, object>();
const raws = new WeakMap<object, object>();

const wrappable = (v: unknown): v is object => {
  if (typeof v !== 'object' || v === null) return false;
  const tag = Object.prototype.toString.call(v);
  return tag === '[object Object]' || tag === '[object Array]';
};
const plain = (v: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
};

/** The object behind a live proxy; literals built in the UI are cleaned of nested proxies. */
export function raw<T>(value: T, depth = 0): T {
  if (typeof value !== 'object' || value === null) return value;
  const target = raws.get(value);
  if (target) return target as T;
  if (depth > 5 || !wrappable(value) || !plain(value) || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const clean = raw(item, depth + 1);
      if (clean !== item) value[i] = clean;
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const clean = raw(record[key], depth + 1);
    if (clean !== record[key]) record[key] = clean;
  }
  return value;
}

function make<T extends object>(target: T, tracked: boolean): T {
  const out = (v: unknown): unknown => {
    if (!tracked) return v;
    if (v instanceof Promise) return v.then((r: unknown) => wrap(r, true));
    return wrap(v, true);
  };
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (tracked) void state.v;
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        if (prop === 'constructor') return value;
        const fn = value as (...a: unknown[]) => unknown;
        return (...args: unknown[]) => out(untrack(() => fn.apply(t, args.map((a) => raw(a)))));
      }
      // A frozen target must hand back its own values (proxy invariant).
      return Object.isFrozen(t) ? value : wrap(value, tracked);
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, raw(value), t);
    },
    has(t, prop) {
      if (tracked) void state.v;
      return Reflect.has(t, prop);
    },
    ownKeys(t) {
      if (tracked) void state.v;
      return Reflect.ownKeys(t);
    },
  });
  raws.set(proxy, target);
  return proxy;
}

function wrap<T>(value: T, tracked: boolean): T {
  if (!wrappable(value) || raws.has(value)) return value;
  if (!tracked && plain(value)) return value; // bridges hand data back untouched
  const cache = tracked ? proxies : bridges;
  let proxy = cache.get(value);
  if (!proxy) cache.set(value, (proxy = make(value, tracked)));
  return proxy as T;
}

/** Reactive view of a model (and of everything reachable from it). */
export const live = <T>(model: T): T => wrap(model, true);
/** Untracked view of a service container: only strips proxies from the arguments of its methods. */
export const bridge = <T extends object>(services: T): T => make(services, false);
