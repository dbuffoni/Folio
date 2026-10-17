// View-models for digital signatures: certificate management (FR-CRT-*), the sign dialog (FR-SIG-01…03,
// 07, 08) and the signature panel (FR-SIG-04…06). Pure logic, no DOM: the shell only renders them.
import { InvalidArgumentError, msg, splitExt, type Msg } from '@folio/core';
import type { StoredSignature } from '@folio/db';
import type { FileRef, Rect } from '@folio/ports';
import {
  CertificateError,
  SigningError,
  TimestampError,
  listSignatureFields,
  signPdf,
  validateSignatures,
  type CertificateEntry,
  type CertificateKind,
  type SignatureAppearance,
  type SignatureField,
  type SignatureReport,
} from '@folio/services';
import type { AppModel } from './app.ts';
import { ViewModel } from './features.ts';
import type { DocumentSession } from './session.ts';

/** Problems the user can fix get their own message; everything else goes through the generic error toast. */
function describe(e: unknown): Msg | null {
  if (e instanceof CertificateError) return msg(`cert.error.${e.code}`);
  if (e instanceof SigningError) return msg(`dsig.error.${e.code}`);
  if (e instanceof TimestampError) return msg(`dsig.tsError.${e.code}`);
  return null;
}

// ---- Certificates (FR-CRT-01…04) -----------------------------------------------------------------

export class CertificatesModel extends ViewModel {
  identities: CertificateEntry[] = [];
  trusted: CertificateEntry[] = [];
  selected: { kind: CertificateKind; fingerprint: string } | null = null;
  busy = false;
  /** Last problem the user can fix (wrong password, unsupported key), shown in the pane. */
  error: Msg | null = null;

  constructor(private readonly app: AppModel) {
    super();
  }
  private get svc() {
    return this.app.services.certificates;
  }
  /** Whether imported keys survive a restart (OS keychain) or live for this session only. */
  get keysPersist(): boolean {
    return this.svc.persistsKeys;
  }
  get current(): CertificateEntry | null {
    const s = this.selected;
    if (!s) return null;
    return (
      (s.kind === 'identity' ? this.identities : this.trusted).find((c) => c.fingerprint === s.fingerprint) ??
      null
    );
  }

  async load(): Promise<void> {
    this.identities = await this.svc.list('identity');
    this.trusted = await this.svc.list('trusted');
    if (this.selected && !this.current) this.selected = null;
    this.emit();
  }
  select(kind: CertificateKind, fingerprint: string): void {
    this.selected = { kind, fingerprint };
    this.emit();
  }

  /** Picks a .p12/.pfx file and asks for its password until it opens or the user gives up. Returns the new entry. */
  async importIdentity(): Promise<CertificateEntry | null> {
    const files = this.app.services.platform.files;
    const [ref] = await files.pickOpen({ accept: ['pkcs12'] });
    if (!ref) return null;
    return this.importIdentityFrom(ref);
  }
  async importIdentityFrom(ref: FileRef): Promise<CertificateEntry | null> {
    this.error = null;
    this.busy = true;
    this.emit();
    try {
      const bytes = await this.app.services.platform.files.read(ref);
      let wrong = false;
      for (;;) {
        const password = await this.app.prompts.askPassword(ref.name, wrong);
        if (password === null) return null;
        try {
          const { entry, persisted } = await this.svc.importIdentity(bytes, password);
          await this.load();
          this.select('identity', entry.fingerprint);
          this.app.toast(
            'success',
            msg(persisted ? 'cert.imported' : 'cert.importedSession', { name: entry.commonName }),
          );
          return entry;
        } catch (e) {
          if (e instanceof CertificateError && e.code === 'bad-password') {
            wrong = true;
            continue;
          }
          const m = describe(e);
          if (!m) throw e;
          this.error = m;
          return null;
        }
      }
    } catch (e) {
      this.app.reportError(e);
      return null;
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  /** Picks one or more certificate files to trust. Returns how many certificates were added. */
  async importTrusted(): Promise<number> {
    const [ref] = await this.app.services.platform.files.pickOpen({ accept: ['certificate'] });
    if (!ref) return 0;
    this.error = null;
    const added = await this.app.guard(async () => {
      try {
        return await this.svc.importTrusted(await this.app.services.platform.files.read(ref));
      } catch (e) {
        const m = describe(e);
        if (!m) throw e;
        this.error = m;
        return [];
      }
    });
    await this.load();
    if (added?.length) {
      this.select('trusted', added[0]!.fingerprint);
      this.app.toast('success', msg('cert.trustedAdded', { count: added.length }));
    }
    return added?.length ?? 0;
  }

  async remove(kind: CertificateKind, fingerprint: string): Promise<boolean> {
    const entry = (kind === 'identity' ? this.identities : this.trusted).find(
      (c) => c.fingerprint === fingerprint,
    );
    if (!entry) return false;
    const ok = await this.app.prompts.confirm(
      msg(kind === 'identity' ? 'cert.confirmRemoveIdentity' : 'cert.confirmRemoveTrusted', {
        name: entry.commonName,
      }),
      { danger: true, confirmLabel: msg('cert.remove') },
    );
    if (!ok) return false;
    await this.app.guard(() => this.svc.remove(fingerprint, kind));
    await this.load();
    return true;
  }
}

// ---- Sign dialog (FR-SIG-01…03, 07, 08) ----------------------------------------------------------

export type SignPlacement = 'invisible' | 'new' | 'field';
export type SignCorner =
  'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'bottom-center' | 'top-center';
export type SignStage = 'idle' | 'ready' | 'running' | 'done';

const BOX = { width: 220, height: 64 };
const MARGIN = 36;

export class DigitalSignModel extends ViewModel {
  stage: SignStage = 'idle';
  identities: CertificateEntry[] = [];
  identity = '';
  fields: SignatureField[] = [];
  placement: SignPlacement = 'new';
  fieldName = '';
  page = 0;
  corner: SignCorner = 'bottom-right';
  reason = '';
  location = '';
  contact = '';
  showDate = true;
  /** Library signature drawn next to the text, or none. */
  artwork: string | null = null;
  artworkChoices: StoredSignature[] = [];
  timestamp = false;
  embedValidation = false;
  /** 'copy' writes name-signed.pdf; 'replace' overwrites the open file. */
  target: 'copy' | 'replace' = 'copy';
  error: Msg | null = null;
  result: { name: string } | null = null;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }

  private get settings() {
    return this.app.settings.signing;
  }
  get encrypted(): boolean {
    return this.session.meta.isEncrypted;
  }
  get alreadySigned(): boolean {
    return this.session.meta.hasSignatures;
  }
  get pageCount(): number {
    return this.session.pageCount;
  }
  get canReplace(): boolean {
    return !!this.session.ref;
  }
  get chosen(): CertificateEntry | undefined {
    return this.identities.find((i) => i.fingerprint === this.identity);
  }
  /** Network steps need an authority address and a shell that can reach it. */
  get timestampReady(): boolean {
    return !!this.settings.tsaUrl && !!this.app.services.platform.network;
  }
  get networkAvailable(): boolean {
    return !!this.app.services.platform.network;
  }
  get tsaUrl(): string {
    return this.settings.tsaUrl;
  }
  get canSign(): boolean {
    if (this.stage !== 'ready' || this.encrypted || !this.chosen) return false;
    if (this.placement === 'field' && !this.openFields.some((f) => f.name === this.fieldName)) return false;
    if (this.timestamp && !this.timestampReady) return false;
    return true;
  }
  /** Empty signature fields the file already has. */
  get openFields(): SignatureField[] {
    return this.fields.filter((f) => !f.signed);
  }

  async start(): Promise<void> {
    this.stage = 'idle';
    this.error = null;
    this.result = null;
    this.emit();
    await this.app.guard(async () => {
      await this.session.settled();
      this.identities = (await this.app.services.certificates.list('identity')).filter((i) => i.usable);
      const last = this.settings.lastIdentity;
      this.identity =
        this.identities.find((i) => i.fingerprint === last)?.fingerprint ??
        this.identities[0]?.fingerprint ??
        '';
      this.artworkChoices = await this.app.services.signaturesRepo.list();
      this.timestamp = this.settings.timestamp && this.timestampReady;
      this.embedValidation = this.settings.embedValidation && this.networkAvailable;
      this.target = 'copy';
      const bytes = await this.currentBytes();
      this.fields = await listSignatureFields(bytes).catch(() => []);
      const free = this.openFields[0];
      if (free) {
        this.placement = 'field';
        this.fieldName = free.name;
        this.page = free.page;
      } else {
        this.placement = 'new';
        this.page = Math.max(0, this.session.view.page);
      }
      this.stage = 'ready';
    });
    this.emit();
  }

  private async currentBytes(): Promise<Uint8Array> {
    return this.session.doc.save({ incremental: this.session.meta.hasSignatures });
  }

  setIdentity(fingerprint: string): void {
    this.identity = fingerprint;
    this.emit();
  }
  setPlacement(p: SignPlacement): void {
    this.placement = p;
    this.emit();
  }
  setField(name: string): void {
    this.fieldName = name;
    const f = this.fields.find((x) => x.name === name);
    if (f) this.page = f.page;
    this.emit();
  }
  setPage(page: number): void {
    this.page = Math.max(0, Math.min(this.pageCount - 1, Math.floor(page)));
    this.emit();
  }
  setCorner(c: SignCorner): void {
    this.corner = c;
    this.emit();
  }
  set(
    patch: Partial<
      Pick<
        DigitalSignModel,
        'reason' | 'location' | 'contact' | 'showDate' | 'artwork' | 'timestamp' | 'embedValidation'
      >
    >,
  ): void {
    Object.assign(this, patch);
    this.emit();
  }
  setTarget(t: 'copy' | 'replace'): void {
    this.target = t === 'replace' && !this.canReplace ? 'copy' : t;
    this.emit();
  }

  /** Where the new signature box goes on the page, in PDF user space (inside the crop box). */
  async boxFor(page: number): Promise<Rect> {
    const info = await this.session.doc.getPageInfo(page);
    const c = info.cropBox;
    const w = Math.min(BOX.width, c.width - 2 * MARGIN);
    const h = Math.min(BOX.height, c.height - 2 * MARGIN);
    const left = c.x + MARGIN;
    const right = c.x + c.width - MARGIN - w;
    const midX = c.x + (c.width - w) / 2;
    const bottom = c.y + MARGIN;
    const top = c.y + c.height - MARGIN - h;
    const x = this.corner.endsWith('left') ? left : this.corner.endsWith('right') ? right : midX;
    const y = this.corner.startsWith('top') ? top : bottom;
    return { x, y, width: Math.max(w, 40), height: Math.max(h, 24) };
  }

  /** Text lines of the visible appearance. */
  lines(identity: CertificateEntry): string[] {
    // Text drawn into the document, not UI: fixed English like the stamp dates.
    const lines = [`Digitally signed by ${identity.commonName}`];
    if (this.showDate)
      lines.push(
        `Date: ${this.app.services.platform.clock.now().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      );
    if (this.reason.trim()) lines.push(`Reason: ${this.reason.trim()}`);
    if (this.location.trim()) lines.push(`Location: ${this.location.trim()}`);
    return lines;
  }

  /** Signs and writes the file. Returns the written file name, or null (cancelled or failed). */
  async run(): Promise<string | null> {
    const chosen = this.chosen;
    if (!chosen || !this.canSign) return null;
    this.stage = 'running';
    this.error = null;
    this.emit();
    const files = this.app.services.platform.files;
    const network = this.app.services.platform.network;
    let signed: Uint8Array | undefined;
    try {
      await this.session.settled();
      const identity = await this.app.services.certificates.openIdentity(chosen.fingerprint);
      if (!identity) {
        this.error = msg('dsig.error.keyGone');
        return null;
      }
      const bytes = await this.currentBytes();
      const appearance: SignatureAppearance | undefined =
        this.placement === 'invisible'
          ? undefined
          : this.placement === 'field'
            ? await this.fieldAppearance(chosen)
            : {
                page: this.page,
                rect: await this.boxFor(this.page),
                lines: this.lines(chosen),
                image: await this.artworkImage(),
              };
      signed = await signPdf(bytes, {
        identity,
        fieldName: this.placement === 'field' ? this.fieldName : undefined,
        appearance,
        reason: this.reason.trim() || undefined,
        location: this.location.trim() || undefined,
        contactInfo: this.contact.trim() || undefined,
        signingTime: this.app.services.platform.clock.now(),
        timestamp: this.timestamp && network ? { url: this.settings.tsaUrl, transport: network } : undefined,
        validationData: this.embedValidation && network ? network : undefined,
      });
    } catch (e) {
      const m = describe(e);
      if (m) this.error = m;
      else this.app.reportError(e);
      return null;
    } finally {
      if (!signed) {
        this.stage = 'ready';
        this.emit();
      }
    }
    const replace = this.target === 'replace' && this.canReplace;
    const ref = replace
      ? this.session.ref!
      : await files.pickSave({ suggestedName: this.copyName(), kind: 'pdf' });
    if (!ref) {
      this.stage = 'ready';
      this.emit();
      return null;
    }
    const written = await this.app.guard(async () => {
      await files.write(ref, signed!, {
        atomic: true,
        backup: replace ? this.app.settings.keepBackup : false,
      });
      return true;
    });
    if (!written) {
      this.stage = 'ready';
      this.emit();
      return null;
    }
    await this.app.setSetting('signing', { ...this.settings, lastIdentity: chosen.fingerprint });
    this.stage = 'done';
    this.result = { name: ref.name };
    this.emit();
    this.app.toast('success', msg('dsig.done', { name: ref.name }));
    if (replace) {
      this.session.markSaved(ref, signed.length);
      await this.app.closeTab(this.session.id);
    }
    await this.app.openRef(ref);
    return ref.name;
  }

  copyName(): string {
    const [stem] = splitExt(this.session.name);
    return `${stem}-signed.pdf`;
  }

  private async fieldAppearance(identity: CertificateEntry): Promise<SignatureAppearance | undefined> {
    const f = this.fields.find((x) => x.name === this.fieldName);
    if (!f || f.rect.width <= 0 || f.rect.height <= 0) return undefined;
    return { page: f.page, rect: f.rect, lines: this.lines(identity), image: await this.artworkImage() };
  }
  private async artworkImage(): Promise<{ bytes: Uint8Array; mime: 'image/png' } | undefined> {
    const art = this.artworkChoices.find((s) => s.id === this.artwork);
    return art ? { bytes: art.png, mime: 'image/png' } : undefined;
  }
}

// ---- Signature panel (FR-SIG-04…06) --------------------------------------------------------------

export type SignatureSummary = 'none' | 'valid' | 'warning' | 'invalid';

export class SignaturePanelModel extends ViewModel {
  reports: SignatureReport[] = [];
  loading = false;
  checked = false;
  selected = 0;
  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  get hasSignatures(): boolean {
    return this.session.meta.hasSignatures;
  }
  /** One word for the badge: any invalid signature wins, then anything not fully trusted. */
  get summary(): SignatureSummary {
    if (!this.reports.length) return 'none';
    if (this.reports.some((r) => r.status === 'invalid')) return 'invalid';
    if (
      this.reports.some(
        (r) => r.status !== 'valid' || (r.changedAfterSigning && r.index === this.reports.length - 1),
      )
    )
      return 'warning';
    return 'valid';
  }
  get revocationOn(): boolean {
    return this.app.settings.signing.revocationCheck && !!this.app.services.platform.network;
  }
  get current(): SignatureReport | null {
    return this.reports[this.selected] ?? null;
  }
  select(i: number): void {
    this.selected = Math.max(0, Math.min(this.reports.length - 1, i));
    this.emit();
  }

  /** Checks every signature of the document as it is on screen (saved bytes plus unsaved edits). */
  async validate(): Promise<void> {
    this.loading = true;
    this.emit();
    await this.app.guard(async () => {
      await this.session.settled();
      // An untouched document is checked as it is on disk; saving it again would append an update of our own.
      const { ref } = this.session;
      const bytes =
        ref && !this.session.dirty
          ? await this.app.services.platform.files.read(ref)
          : await this.session.doc.save({ incremental: true });
      this.reports = await validateSignatures(bytes, {
        trusted: await this.app.services.certificates.trustedDer(),
        now: this.app.services.platform.clock.now(),
        revocation: this.revocationOn ? this.app.services.platform.network : undefined,
      });
      this.selected = Math.min(this.selected, Math.max(0, this.reports.length - 1));
    });
    this.loading = false;
    this.checked = true;
    this.emit();
  }

  /** "Trust this signer": adds the signer certificate to the trusted list and checks again. */
  async trustSigner(index = this.selected): Promise<boolean> {
    const r = this.reports[index];
    if (!r?.signerDer || !r.signer) return false;
    const ok = await this.app.prompts.confirm(
      msg('sigpanel.confirmTrust', {
        name: r.signer.commonName,
        fingerprint: r.signer.fingerprint.slice(0, 16).toUpperCase(),
      }),
      { confirmLabel: msg('sigpanel.trust') },
    );
    if (!ok) return false;
    const done = await this.app.guard(() => this.app.services.certificates.trustDer(r.signerDer!));
    if (!done) return false;
    await this.validate();
    return true;
  }
}

export { InvalidArgumentError };
