import type { OidcConfig } from '../config.js';
import type { GlobalSettings } from '../domain/settings.js';

/** An issuer from the environment, or one saved in Settings with the secret from the environment. */
export function effectiveOidcConfig(
  env: OidcConfig | undefined,
  stored: GlobalSettings['oidc'],
  clientSecret: string | undefined,
): OidcConfig | undefined {
  if (env) return env;
  if (!stored || clientSecret === undefined) return undefined;
  return {
    issuer: stored.issuer,
    clientId: stored.clientId,
    allowedDomains: stored.allowedDomains,
    clientSecret,
    trustUnverifiedEmail: stored.trustUnverifiedEmail === true,
  };
}
