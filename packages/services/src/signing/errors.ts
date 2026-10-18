// Error types of the signing services. Kept apart from the modules that pull in pkijs so the app can
// test `instanceof` without loading the signing code (which is imported on demand).

export class CertificateError extends Error {
  constructor(
    readonly code: 'bad-password' | 'unsupported' | 'invalid' | 'no-key' | 'no-certificate',
    message: string,
  ) {
    super(message);
    this.name = 'CertificateError';
  }
}

export class SigningError extends Error {
  constructor(
    readonly code: 'encrypted' | 'damaged' | 'field-not-found' | 'field-signed' | 'bad-page' | 'bad-image' | 'too-large' | 'revoked',
    message: string,
  ) {
    super(message);
    this.name = 'SigningError';
  }
}

export class TimestampError extends Error {
  constructor(
    readonly code: 'network' | 'rejected' | 'invalid' | 'url',
    message: string,
  ) {
    super(message);
    this.name = 'TimestampError';
  }
}
