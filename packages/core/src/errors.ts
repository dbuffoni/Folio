/** Typed errors (SPEC §8.12). `code` maps to a user message key `error.<code>` in the i18n table. */
export type ErrorCode =
  | 'passwordRequired'
  | 'wrongPassword'
  | 'invalidPdf'
  | 'unsupportedFeature'
  | 'outOfMemory'
  | 'io'
  | 'network'
  | 'ai'
  | 'invalidArgument'
  | 'cancelled'
  | 'limitExceeded';

export class FolioError extends Error {
  readonly code: ErrorCode;
  /** Parameters for the user message. */
  readonly params: Record<string, string | number>;
  /** Technical detail for the "Details" disclosure; never shown as the main message. */
  readonly detail?: string;
  constructor(code: ErrorCode, message: string, opts: { params?: Record<string, string | number>; detail?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.params = opts.params ?? {};
    this.detail = opts.detail;
  }
}
export class PasswordRequiredError extends FolioError {
  constructor(wrong = false) {
    super(wrong ? 'wrongPassword' : 'passwordRequired', wrong ? 'Wrong password' : 'Password required');
  }
}
export class InvalidPdfError extends FolioError {
  constructor(detail?: string) {
    super('invalidPdf', 'The file is not a valid PDF', { detail });
  }
}
export class UnsupportedFeatureError extends FolioError {
  /** `feature` is a stable identifier such as "xfa", "rotatedText", "scannedText". */
  constructor(readonly feature: string, detail?: string) {
    super('unsupportedFeature', `Unsupported: ${feature}`, { params: { feature }, detail });
  }
}
export class OutOfMemoryError extends FolioError {
  constructor(detail?: string) {
    super('outOfMemory', 'Out of memory', { detail });
  }
}
export class IoError extends FolioError {
  constructor(detail?: string, cause?: unknown) {
    super('io', 'File operation failed', { detail, cause });
  }
}
export class NetworkError extends FolioError {
  constructor(detail?: string, cause?: unknown) {
    super('network', 'Network request failed', { detail, cause });
  }
}
/**
 * `insecure`: plain http to a host that is not this computer. `unsupported`: the model cannot do
 * what the feature needs (images, JSON output), as found by the capability check (FR-AIF-13).
 */
export type AiErrorKind = 'notConfigured' | 'unauthorized' | 'rateLimited' | 'malformed' | 'server' | 'blocked' | 'insecure' | 'unsupported';
export class AiError extends FolioError {
  constructor(readonly kind: AiErrorKind, detail?: string) {
    super('ai', `AI request failed: ${kind}`, { params: { kind }, detail });
  }
}
export class InvalidArgumentError extends FolioError {
  constructor(message: string, params?: Record<string, string | number>) {
    super('invalidArgument', message, { params });
  }
}
export class CancelledError extends FolioError {
  constructor() {
    super('cancelled', 'Cancelled');
  }
}
export class LimitExceededError extends FolioError {
  constructor(readonly limit: string, detail?: string) {
    super('limitExceeded', `Limit exceeded: ${limit}`, { params: { limit }, detail });
  }
}

export function isFolioError(e: unknown): e is FolioError {
  return e instanceof FolioError;
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
