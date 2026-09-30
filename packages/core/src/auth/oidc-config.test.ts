import { describe, expect, it } from 'vitest';

import type { OidcConfig } from '../config.js';
import { effectiveOidcConfig } from './oidc-config.js';

const stored = { issuer: 'https://id.acme.test', clientId: 'sb', allowedDomains: ['acme.test'] };

describe('effectiveOidcConfig', () => {
  it('prefers the issuer from the environment', () => {
    const env: OidcConfig = {
      ...stored,
      issuer: 'https://env.test',
      clientSecret: 'fixture-secret',
    };
    expect(effectiveOidcConfig(env, stored, 'other')).toBe(env);
  });

  it('uses the issuer saved in Settings with the client secret from the environment', () => {
    expect(effectiveOidcConfig(undefined, stored, 'fixture-secret')).toEqual({
      ...stored,
      clientSecret: 'fixture-secret',
      trustUnverifiedEmail: false,
    });
  });

  it('carries trustUnverifiedEmail from the Settings issuer', () => {
    expect(
      effectiveOidcConfig(undefined, { ...stored, trustUnverifiedEmail: true }, 'fixture-secret')
        ?.trustUnverifiedEmail,
    ).toBe(true);
  });

  it('has no issuer without a saved one or without the client secret', () => {
    expect(effectiveOidcConfig(undefined, null, 'fixture-secret')).toBeUndefined();
    expect(effectiveOidcConfig(undefined, stored, undefined)).toBeUndefined();
  });
});
