import { describe, expect, it } from 'vitest';
import { migrate, CertificateRepo } from '@folio/db';
import type { SecretStore } from '@folio/ports';
import { FakeClock, InMemoryDatabase, opensslPkcs12, pki } from '@folio/testkit';
import { CertificateError, CertificateService, certDer, certFingerprint, signPdf, validateSignatures } from './index.ts';
import { textDoc } from '@folio/testkit';

class Secrets implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly kind: SecretStore['kind']) {}
  async get(k: string) {
    return this.values.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.values.set(k, v);
  }
  async remove(k: string) {
    this.values.delete(k);
  }
}

async function setup(kind: SecretStore['kind'] = 'os-keychain') {
  const db = new InMemoryDatabase();
  await migrate(db);
  const clock = new FakeClock(new Date(Date.now() + 3600e3));
  const secrets = new Secrets(kind);
  const svc = new CertificateService({ repo: new CertificateRepo(db, clock), secrets, clock });
  return { db, clock, secrets, svc };
}

describe('Certificate management @FR-CRT-01 @FR-CRT-02 @FR-CRT-03 @FR-CRT-04', () => {
  it('imports an identity, keeps the key in the keychain and signs with it later @FR-CRT-01 @FR-CRT-04', async () => {
    const { svc, db, secrets } = await setup();
    const { p12 } = await opensslPkcs12({ cn: 'Ada Lovelace', password: 'pw' });
    const { entry, persisted } = await svc.importIdentity(p12, 'pw');
    expect(persisted).toBe(true);
    expect(entry).toMatchObject({ kind: 'identity', commonName: 'Ada Lovelace', keyAlgorithm: 'RSA', validity: 'valid', usable: true });
    // Public data in the database, key material only in the secret store.
    const rows = await db.select<Record<string, unknown>>('SELECT * FROM certificates');
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(p12).toString('base64').slice(0, 64));
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect([...secrets.values.keys()]).toEqual([`folio.cert.${entry.fingerprint}`]);
    // A fresh service (restart) still finds the identity and signs.
    const again = new CertificateService({ repo: svc['deps'].repo, secrets, clock: svc['deps'].clock });
    expect((await again.list('identity'))[0]!.usable).toBe(true);
    const identity = await again.openIdentity(entry.fingerprint);
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: identity! });
    expect((await validateSignatures(signed))[0]!.signer!.fingerprint).toBe(entry.fingerprint);
  });

  it('keeps the key in memory only when there is no keychain @FR-CRT-04', async () => {
    const { svc, secrets } = await setup('passphrase-encrypted');
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'pw' });
    const { entry, persisted } = await svc.importIdentity(p12, 'pw');
    expect(persisted).toBe(false);
    expect(secrets.values.size).toBe(0);
    expect(await svc.openIdentity(entry.fingerprint)).not.toBeNull();
    const restarted = new CertificateService({ repo: svc['deps'].repo, secrets, clock: svc['deps'].clock });
    expect((await restarted.list('identity'))[0]).toMatchObject({ commonName: 'Ada', usable: false });
    expect(await restarted.openIdentity(entry.fingerprint)).toBeNull();
  });

  it('rejects a wrong password and stores nothing @FR-CRT-01', async () => {
    const { svc, db, secrets } = await setup();
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'pw' });
    await expect(svc.importIdentity(p12, 'nope')).rejects.toBeInstanceOf(CertificateError);
    expect(await db.select('SELECT * FROM certificates')).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });

  it('importing the same file twice updates one entry @FR-CRT-01', async () => {
    const { svc } = await setup();
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'pw' });
    await svc.importIdentity(p12, 'pw');
    await svc.importIdentity(p12, 'pw');
    expect(await svc.list('identity')).toHaveLength(1);
  });

  it('imports trusted certificates from DER and PEM and uses them for validation @FR-CRT-02 @FR-CRT-03', async () => {
    const { svc } = await setup();
    const { root, identity } = await pki();
    const [entry] = await svc.importTrusted(certDer(root.certificate));
    expect(entry).toMatchObject({ kind: 'trusted', commonName: 'Folio Test Root CA', isCa: true });
    expect(await svc.isTrusted(certDer(root.certificate))).toBe(true);
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    expect((await validateSignatures(signed, { trusted: await svc.trustedDer() }))[0]!.status).toBe('valid');
    await svc.remove(entry!.fingerprint, 'trusted');
    expect(await svc.isTrusted(certDer(root.certificate))).toBe(false);
    expect((await validateSignatures(signed, { trusted: await svc.trustedDer() }))[0]!.status).toBe('valid-untrusted');
    // The "Trust this signer" shortcut of the validation panel.
    await svc.trustDer(certDer(identity.certificates[0]!));
    expect((await validateSignatures(signed, { trusted: await svc.trustedDer() }))[0]!.status).toBe('valid');
    expect(await certFingerprint(identity.certificates[0]!)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('removing an identity deletes its keychain entry; expired certificates are marked @FR-CRT-03', async () => {
    const { svc, secrets, clock } = await setup();
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'pw' });
    const { entry } = await svc.importIdentity(p12, 'pw');
    expect(secrets.values.size).toBe(1);
    clock.advance(400 * 24 * 3600e3);
    expect((await svc.list('identity'))[0]!.validity).toBe('expired');
    await svc.remove(entry.fingerprint, 'identity');
    expect(secrets.values.size).toBe(0);
    expect(await svc.list('identity')).toEqual([]);
    expect(await svc.openIdentity(entry.fingerprint)).toBeNull();
  });
});
