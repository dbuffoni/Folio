// Typed RPC between the UI thread and the engine worker (SPEC §8.7). Transport-agnostic: anything
// with postMessage/onmessage works (Worker, MessagePort), which is how it is tested in plain Node.
import { CancelledError, FolioError, isFolioError, type ErrorCode } from '@folio/core';
import type { PdfDocument, PdfEngine, SearchHit, SearchQuery } from '@folio/ports';

export interface RpcPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface DocRef {
  __doc: string;
}
type Request =
  | { t: 'call'; id: number; doc: string | null; method: string; args: unknown[] }
  | { t: 'abort'; id: number }
  | { t: 'release'; doc: string };
type Reply =
  | { t: 'ok'; id: number; value: unknown; pageCount?: number }
  | { t: 'err'; id: number; error: SerializedError };
interface SerializedError {
  folio: boolean;
  code?: ErrorCode;
  name: string;
  message: string;
  params?: Record<string, string | number>;
  detail?: string;
}
const SIGNAL = '__signal';

const isDocRef = (v: unknown): v is DocRef =>
  typeof v === 'object' && v !== null && typeof (v as DocRef).__doc === 'string';

/** Buffers worth transferring instead of copying. */
function transferables(value: unknown, out: Transferable[] = []): Transferable[] {
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
    if (
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength &&
      value.buffer instanceof ArrayBuffer
    )
      out.push(value.buffer);
  } else if (Array.isArray(value)) {
    for (const v of value) transferables(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) transferables(v, out);
  }
  return out;
}

// ---- server (inside the worker) ------------------------------------------------------------------

/** Exposes a PdfEngine over a port. Documents live in the worker; the client holds ids. */
export function serveEngine(engine: PdfEngine | Promise<PdfEngine>, port: RpcPort): void {
  const docs = new Map<string, PdfDocument>();
  const running = new Map<number, AbortController>();
  const revive = (v: unknown): unknown => {
    if (isDocRef(v)) {
      const d = docs.get(v.__doc);
      if (!d) throw new FolioError('invalidArgument', 'Unknown document');
      return d;
    }
    if (Array.isArray(v)) return v.map(revive);
    if (
      typeof v === 'object' &&
      v !== null &&
      !(v instanceof Uint8Array) &&
      !(v instanceof Uint8ClampedArray)
    ) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
    }
    return v;
  };
  const register = (doc: PdfDocument): DocRef & { pageCount: number } => {
    docs.set(doc.id, doc);
    return { __doc: doc.id, pageCount: doc.pageCount };
  };
  const fail = (id: number, e: unknown): void => {
    const error: SerializedError = isFolioError(e)
      ? { folio: true, code: e.code, name: e.name, message: e.message, params: e.params, detail: e.detail }
      : {
          folio: false,
          name: e instanceof Error ? e.name : 'Error',
          message: e instanceof Error ? e.message : String(e),
        };
    port.postMessage({ t: 'err', id, error } satisfies Reply);
  };

  port.onmessage = ({ data }) => {
    const msg = data as Request;
    if (msg.t === 'abort') {
      running.get(msg.id)?.abort();
      return;
    }
    if (msg.t === 'release') {
      docs.get(msg.doc)?.dispose();
      docs.delete(msg.doc);
      return;
    }
    void (async () => {
      const ac = new AbortController();
      running.set(msg.id, ac);
      try {
        const eng = await engine;
        const target: unknown = msg.doc === null ? eng : docs.get(msg.doc);
        if (!target) throw new FolioError('invalidArgument', 'Document is disposed');
        const fn = (target as Record<string, unknown>)[msg.method];
        if (typeof fn !== 'function' || msg.method.startsWith('_') || msg.method === 'constructor')
          throw new FolioError('invalidArgument', `Unknown method ${msg.method}`);
        const args = (revive(msg.args) as unknown[]).map((a) => (a === SIGNAL ? ac.signal : a));
        let value: unknown = (fn as (...a: unknown[]) => unknown).apply(target, args);
        if (msg.method === 'search') {
          // Async iterables do not cross the boundary: collect, then hand over the list.
          const hits: SearchHit[] = [];
          for await (const h of value as AsyncIterable<SearchHit>) {
            if (ac.signal.aborted) throw new CancelledError();
            hits.push(h);
          }
          value = hits;
        } else {
          value = await value;
        }
        if (
          value &&
          typeof value === 'object' &&
          'pageCount' in value &&
          typeof (value as PdfDocument).getPageInfo === 'function'
        )
          value = register(value as PdfDocument);
        const pageCount = msg.doc !== null ? docs.get(msg.doc)?.pageCount : undefined;
        port.postMessage({ t: 'ok', id: msg.id, value, pageCount } satisfies Reply, transferables(value));
      } catch (e) {
        fail(msg.id, e);
      } finally {
        running.delete(msg.id);
      }
    })();
  };
}

// ---- client (UI thread) --------------------------------------------------------------------------

class Channel {
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (r: Reply & { t: 'ok' }) => void; reject: (e: unknown) => void }
  >();
  constructor(private readonly port: RpcPort) {
    port.onmessage = ({ data }) => {
      const reply = data as Reply;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.t === 'ok') p.resolve(reply);
      else
        p.reject(
          reply.error.folio
            ? Object.assign(
                new FolioError(reply.error.code!, reply.error.message, {
                  params: reply.error.params,
                  detail: reply.error.detail,
                }),
                { name: reply.error.name },
              )
            : Object.assign(new Error(reply.error.message), { name: reply.error.name }),
        );
    };
  }
  call(
    doc: string | null,
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<Reply & { t: 'ok' }> {
    if (signal?.aborted) return Promise.reject(new CancelledError());
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => this.port.postMessage({ t: 'abort', id } satisfies Request);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      // Arguments are copied, not transferred: callers keep using their buffers.
      this.port.postMessage({ t: 'call', id, doc, method, args } satisfies Request);
    });
  }
  release(doc: string): void {
    this.port.postMessage({ t: 'release', doc } satisfies Request);
  }
}

const encode = (v: unknown): unknown => {
  if (v instanceof RemoteDocument) return { __doc: v.id } satisfies DocRef;
  if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) return SIGNAL;
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !(v instanceof Uint8ClampedArray))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
};

class RemoteDocument {
  pageCount: number;
  private disposed = false;
  constructor(
    private readonly channel: Channel,
    readonly id: string,
    pageCount: number,
  ) {
    this.pageCount = pageCount;
  }
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    if (this.disposed) throw new FolioError('invalidArgument', 'Document is disposed');
    const signal = args.find(
      (a): a is AbortSignal => typeof AbortSignal !== 'undefined' && a instanceof AbortSignal,
    );
    const reply = await this.channel.call(this.id, method, args.map(encode), signal);
    if (reply.pageCount !== undefined) this.pageCount = reply.pageCount;
    return reply.value;
  }
  async *search(q: SearchQuery): AsyncIterable<SearchHit> {
    yield* (await this.invoke('search', [q])) as SearchHit[];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.release(this.id);
  }
}

function documentProxy(channel: Channel, ref: DocRef & { pageCount: number }): PdfDocument {
  const remote = new RemoteDocument(channel, ref.__doc, ref.pageCount);
  return new Proxy(remote, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, target);
      if (prop === 'then') return undefined; // not a thenable
      return (...args: unknown[]) => target.invoke(prop, args);
    },
  }) as unknown as PdfDocument;
}

/** PdfEngine whose work happens on the other side of `port`. */
export function connectEngine(port: RpcPort): PdfEngine {
  const channel = new Channel(port);
  const doc = async (method: string, args: unknown[]): Promise<PdfDocument> =>
    documentProxy(
      channel,
      (await channel.call(null, method, args.map(encode))).value as DocRef & { pageCount: number },
    );
  return {
    open: (data, opts) => doc('open', [data, opts]),
    create: () => doc('create', []),
    merge: (parts) => doc('merge', [parts]),
    rasterizeText: async (spec) =>
      (await channel.call(null, 'rasterizeText', [spec])).value as Awaited<
        ReturnType<PdfEngine['rasterizeText']>
      >,
    dispose: async () => void (await channel.call(null, 'dispose', [])),
  };
}
