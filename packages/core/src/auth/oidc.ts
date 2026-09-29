import { createHmac, timingSafeEqual } from 'node:crypto';

import * as client from 'openid-client';

import type { OidcConfig } from '../config.js';

export interface OidcStart {
  url: string;
  /** Signed and short-lived; carries state, nonce and the PKCE verifier. */
  cookie: string;
}

export interface OidcIdentity {
  email: string;
  subject: string;
}

export class OidcError extends Error {
  override readonly name = 'OidcError';
}

interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export const OIDC_FLOW_COOKIE = 'sb_oidc';

export class OidcClient {
  private configuration: Promise<client.Configuration> | undefined;

  constructor(
    private readonly config: OidcConfig,
    private readonly redirectUri: string,
    private readonly cookieKey: string,
    private readonly options: { allowInsecure?: boolean } = {},
  ) {}

  get issuer(): string {
    return this.config.issuer;
  }

  private discover(): Promise<client.Configuration> {
    this.configuration ??= client
      .discovery(
        new URL(this.config.issuer),
        this.config.clientId,
        this.config.clientSecret === '' ? undefined : this.config.clientSecret,
        undefined,
        // Evaluation installs may point at a plain-http issuer (a local Keycloak); never in production.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.options.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        this.configuration = undefined;
        throw err;
      });
    return this.configuration;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.cookieKey).update(payload).digest('base64url');
  }

  private encode(flow: FlowState): string {
    const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  private decode(cookie: string | undefined, now: Date): FlowState {
    if (!cookie) throw new OidcError('sign-in flow expired; start again');
    const [payload, sig] = cookie.split('.');
    if (!payload || !sig) throw new OidcError('malformed sign-in state');
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new OidcError('sign-in state failed verification');
    }
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FlowState;
    if (flow.exp < now.getTime()) throw new OidcError('sign-in flow expired; start again');
    return flow;
  }

  async start(now: Date): Promise<OidcStart> {
    const configuration = await this.discover();
    const verifier = client.randomPKCECodeVerifier();
    const flow: FlowState = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier,
      exp: now.getTime() + 10 * 60_000,
    };
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    return { url: url.href, cookie: this.encode(flow) };
  }

  async callback(currentUrl: URL, cookie: string | undefined, now: Date): Promise<OidcIdentity> {
    const flow = this.decode(cookie, now);
    const configuration = await this.discover();
    const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new OidcError('the issuer returned no ID token');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined;
    if (!email) throw new OidcError('the ID token has no email claim');
    if (claims.email_verified === false) throw new OidcError('the email address is not verified');
    const domains = this.config.allowedDomains.map((d) => d.toLowerCase());
    if (domains.length > 0 && !domains.some((d) => email.endsWith(`@${d}`))) {
      throw new OidcError(`${email} is not in an allowed domain`);
    }
    return { email, subject: claims.sub };
  }
}
