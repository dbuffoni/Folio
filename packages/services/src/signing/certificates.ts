// Certificate management (FR-CRT-01…04): signing identities and trusted certificates. The database holds
// public data only; the PKCS#12 file and its password go to the OS keychain when there is one, and live
// in memory for the session otherwise.
import { InvalidArgumentError, certSecretKey, fromBase64, toBase64 } from '@folio/core';
import type { Clock, SecretStore } from '@folio/ports';
import { CertificateError } from './errors.ts';
import type { CertificateInfo, SigningIdentity } from './certs.ts';

// pkijs is large; load it when a certificate is first read, not with the application.
const loadCerts = () => import('./certs.ts');

export type CertificateKind = 'identity' | 'trusted';

/** What the repository stores for one certificate (public data and its DER encoding). */
export interface CertificateRecord {
  fingerprint: string;
  kind: CertificateKind;
  commonName: string;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  keyAlgorithm: string;
  keyUsage: string[];
  selfSigned: boolean;
  isCa: boolean;
  der: Uint8Array;
  createdAt: string;
}
export interface CertificateStorePort {
  list(kind?: CertificateKind): Promise<CertificateRecord[]>;
  get(fingerprint: string, kind: CertificateKind): Promise<CertificateRecord | null>;
  upsert(c: Omit<CertificateRecord, 'createdAt'>): Promise<CertificateRecord>;
  remove(fingerprint: string, kind: CertificateKind): Promise<void>;
}

export type Validity = 'valid' | 'expired' | 'not-yet-valid';
export interface CertificateEntry extends CertificateRecord {
  validity: Validity;
  /** Identities only: the private key can be used without importing the file again. */
  usable: boolean;
}

interface Held {
  p12: Uint8Array;
  password: string;
}

export interface CertificateServiceDeps {
  repo: CertificateStorePort;
  secrets: SecretStore;
  clock: Clock;
}

export class CertificateService {
  /** Key material kept for this session only (no keychain, or the user chose not to persist). */
  private readonly held = new Map<string, Held>();
  constructor(private readonly deps: CertificateServiceDeps) {}

  /** Private material survives a restart only in the OS keychain; a passphrase store or memory does not count. */
  get persistsKeys(): boolean {
    return this.deps.secrets.kind === 'os-keychain';
  }

  private validity(rec: { notBefore: string; notAfter: string }): Validity {
    const now = this.deps.clock.now().getTime();
    return now > Date.parse(rec.notAfter) ? 'expired' : now < Date.parse(rec.notBefore) ? 'not-yet-valid' : 'valid';
  }

  private toRecord(info: CertificateInfo, der: Uint8Array, kind: CertificateKind): Omit<CertificateRecord, 'createdAt'> {
    return { fingerprint: info.fingerprint, kind, commonName: info.commonName, subject: info.subject, issuer: info.issuer, serial: info.serialNumber, notBefore: info.notBefore, notAfter: info.notAfter, keyAlgorithm: info.keyAlgorithm, keyUsage: info.keyUsage, selfSigned: info.selfSigned, isCa: info.isCa, der };
  }

  async list(kind: CertificateKind): Promise<CertificateEntry[]> {
    const rows = await this.deps.repo.list(kind);
    const out: CertificateEntry[] = [];
    for (const r of rows) out.push({ ...r, validity: this.validity(r), usable: kind === 'identity' ? await this.hasKey(r.fingerprint) : false });
    return out;
  }

  private async hasKey(fingerprint: string): Promise<boolean> {
    return this.held.has(fingerprint) || (await this.deps.secrets.get(certSecretKey(fingerprint))) !== null;
  }

  /**
   * Opens a PKCS#12 file and remembers the identity. Throws CertificateError for a wrong password or an
   * unsupported file; nothing is stored in that case.
   */
  async importIdentity(p12: Uint8Array, password: string): Promise<{ entry: CertificateEntry; persisted: boolean }> {
    const { openPkcs12, certDer } = await loadCerts();
    const identity = await openPkcs12(p12, password);
    const info = identity.info;
    if (info.keyAlgorithm === 'unsupported') throw new CertificateError('unsupported', 'Only RSA and ECDSA (P-256, P-384) keys are supported');
    const rec = await this.deps.repo.upsert(this.toRecord(info, certDer(identity.certificates[0]!), 'identity'));
    const held: Held = { p12: p12.slice(), password };
    let persisted = false;
    if (this.persistsKeys) {
      try {
        await this.deps.secrets.set(certSecretKey(info.fingerprint), JSON.stringify({ p12: toBase64(held.p12), password }));
        persisted = true;
      } catch {
        persisted = false;
      }
    }
    if (persisted) this.held.delete(info.fingerprint);
    else this.held.set(info.fingerprint, held);
    return { entry: { ...rec, validity: this.validity(rec), usable: true }, persisted };
  }

  /** The identity ready to sign with, or null when its key material is gone (import the file again). */
  async openIdentity(fingerprint: string): Promise<SigningIdentity | null> {
    let held = this.held.get(fingerprint);
    if (!held) {
      const raw = await this.deps.secrets.get(certSecretKey(fingerprint));
      if (raw) {
        try {
          const j = JSON.parse(raw) as { p12: string; password: string };
          held = { p12: fromBase64(j.p12), password: j.password };
        } catch {
          return null;
        }
      }
    }
    if (!held) return null;
    return (await loadCerts()).openPkcs12(held.p12, held.password);
  }

  /** Adds trusted certificates from a DER or PEM file; the chain of an identity is never trusted implicitly. */
  async importTrusted(bytes: Uint8Array): Promise<CertificateEntry[]> {
    const { parseCertificates, describeCertificate, certDer } = await loadCerts();
    const certs = parseCertificates(bytes);
    const out: CertificateEntry[] = [];
    for (const cert of certs) {
      const info = await describeCertificate(cert);
      const rec = await this.deps.repo.upsert(this.toRecord(info, certDer(cert), 'trusted'));
      out.push({ ...rec, validity: this.validity(rec), usable: false });
    }
    return out;
  }

  /** Trusts a certificate seen in a signature (the validation panel's "Trust this signer"). */
  async trustDer(der: Uint8Array): Promise<CertificateEntry> {
    const [entry] = await this.importTrusted(der);
    if (!entry) throw new InvalidArgumentError('No certificate to trust');
    return entry;
  }

  async remove(fingerprint: string, kind: CertificateKind): Promise<void> {
    await this.deps.repo.remove(fingerprint, kind);
    if (kind === 'identity') {
      this.held.delete(fingerprint);
      await this.deps.secrets.remove(certSecretKey(fingerprint));
    }
  }

  /** DER of every trusted certificate, for validation. */
  async trustedDer(): Promise<Uint8Array[]> {
    return (await this.deps.repo.list('trusted')).map((r) => r.der);
  }

  async isTrusted(der: Uint8Array): Promise<boolean> {
    const { parseCertificates, certFingerprint } = await loadCerts();
    const [cert] = parseCertificates(der);
    return !!cert && (await this.deps.repo.get(await certFingerprint(cert), 'trusted')) !== null;
  }
}
