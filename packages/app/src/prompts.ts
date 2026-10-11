import type { Msg } from '@folio/core';

/**
 * Questions only a person can answer. The UI implements this with dialogs; tests script it.
 * Every method resolves to a "cancelled" value instead of throwing when the user backs out.
 */
export interface Prompts {
  /** FR-APP-12. `wrong` is true when the previous attempt failed. Null = cancel. */
  askPassword(fileName: string, wrong: boolean): Promise<string | null>;
  /** FR-APP-07 close guard. */
  confirmClose(fileName: string): Promise<'save' | 'discard' | 'cancel'>;
  /** Generic confirmation for destructive or surprising actions. */
  confirm(message: Msg, opts?: { danger?: boolean; confirmLabel?: Msg }): Promise<boolean>;
  /** FR-APP-11: the file is digitally signed. */
  confirmSignedSave(fileName: string): Promise<'incremental' | 'rewrite' | 'cancel'>;
  /** FR-APP-06: unsaved work from a previous run. */
  offerRecovery(items: Array<{ sessionId: string; name: string; savedAt: string }>): Promise<string[]>;
  /** FR-VIEW-05: "Open example.com?" */
  confirmOpenLink(host: string, uri: string): Promise<boolean>;
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: Msg;
  /** Shown as a button, e.g. Undo. */
  action?: { label: Msg; run: () => void | Promise<void> };
  /** Technical detail for the "Details" disclosure (never the main text). */
  detail?: string;
  /** 0–1 for long operations; undefined for plain toasts. */
  progress?: number;
  cancel?: () => void;
}
