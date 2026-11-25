import { describe, expect, it } from 'vitest';

import { checkCorsOrigin } from './cors-origin.js';

const prod = (allowedOrigins?: string) => ({ isProduction: true, allowedOrigins });

describe('checkCorsOrigin (production)', () => {
  it('accepts the local development and Capacitor origins', () => {
    for (const origin of [
      'http://localhost:5173',
      'https://localhost',
      'capacitor://localhost',
      'http://127.0.0.1:3000',
      'http://[::1]:8080',
    ]) {
      expect(checkCorsOrigin(origin, prod()), origin).toMatchObject({ allowed: true });
    }
  });

  it('accepts recta.app and its real subdomains', () => {
    for (const origin of ['https://recta.app', 'https://www.recta.app', 'https://app.recta.app:8443']) {
      expect(checkCorsOrigin(origin, prod()), origin).toMatchObject({ allowed: true });
    }
  });

  it('rejects hosts that only contain the allowed text', () => {
    for (const origin of [
      'https://recta.app.evil.com',
      'http://evil-localhost.x',
      'https://localhost.evil.com',
      'https://evilrecta.app',
      'https://evil.com/?x=recta.app',
      'https://evil.com#localhost',
      'http://127.0.0.1.evil.com',
    ]) {
      expect(checkCorsOrigin(origin, prod()), origin).toMatchObject({ allowed: false });
    }
  });

  it('rejects an origin that is not a URL', () => {
    expect(checkCorsOrigin('not a url localhost', prod())).toMatchObject({ allowed: false });
    expect(checkCorsOrigin('null', prod())).toMatchObject({ allowed: false });
  });

  it('accepts exactly the origins listed in ALLOWED_ORIGINS', () => {
    const list = ' https://site.example.org , https://other.example.org ';
    expect(checkCorsOrigin('https://site.example.org', prod(list))).toMatchObject({ allowed: true });
    expect(checkCorsOrigin('https://site.example.org.evil.com', prod(list))).toMatchObject({ allowed: false });
    expect(checkCorsOrigin('https://site.example.org', prod())).toMatchObject({ allowed: false });
  });
});

describe('checkCorsOrigin (development)', () => {
  it('accepts any origin', () => {
    expect(checkCorsOrigin('https://anything.example', { isProduction: false })).toMatchObject({ allowed: true });
  });
});
