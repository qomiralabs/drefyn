import * as client from 'openid-client';
import { z } from 'zod';
import type { AuthConfig, OAuthClient } from '../config.ts';
import { AuthError } from '../errors.ts';
import type { OAuthProvider } from '../oauth-types.ts';
import type { AuthLogger } from '../rate-limiter.ts';
import { quietWarn } from '../session-support.ts';
import { createOAuthFetch, type OAuthTransport } from './fetch.ts';

// Endpoints are fixed here, never discovered: a discovery document is one more request
// that could point the flow somewhere else. GitHub publishes none for OAuth apps.
const GITHUB: client.ServerMetadata = {
  issuer: 'https://github.com/login/oauth',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
};

const GOOGLE: client.ServerMetadata = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  id_token_signing_alg_values_supported: ['RS256'],
};

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
} as const;

// What a provider proved about the person. The tokens that proved it never leave
// complete(): they are dropped as soon as the profile and addresses are read.
export interface ProviderProfile {
  readonly subject: string;
  // Only an address the provider marked verified; null otherwise.
  readonly email: string | null;
  // What the person knows the account as, for the link mail: a GitHub login or an address.
  readonly account: string;
  // Seconds since the epoch, when the ID token carried one.
  readonly authTime: number | null;
}

export interface AuthorizationInput {
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly nonce: string | null;
  readonly stepUp: boolean;
}

export interface CompletionInput {
  readonly callback: URL;
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string | null;
}

export interface Provider {
  readonly name: OAuthProvider;
  authorizationUrl(input: AuthorizationInput): URL;
  // Throws AuthError only.
  complete(input: CompletionInput): Promise<ProviderProfile>;
}

const GitHubUser = z.object({
  // The numeric id is the subject; the login can be renamed and then taken by someone else.
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(100),
});

const GitHubEmails = z
  .array(
    z.object({ email: z.string().min(1).max(320), primary: z.boolean(), verified: z.boolean() }),
  )
  .max(1000);

const GoogleClaims = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(1).max(320).optional(),
  email_verified: z.boolean().optional(),
  auth_time: z.number().int().nonnegative().optional(),
});

// Token endpoint codes that mean this code is spent or stale: the person starts again.
const START_AGAIN = new Set(['bad_verification_code', 'expired_token']);
// Codes only an operator can fix.
const MISCONFIGURED = new Set([
  'incorrect_client_credentials',
  'redirect_uri_mismatch',
  'application_suspended',
]);
const ERROR_SHAPE = /^[a-z_]{1,64}$/;

// One mapping for both providers, on the library's documented error type. Nothing from
// the provider's body is kept: no description, no URI, no cause.
function mapError(provider: OAuthProvider, error: unknown, logger: AuthLogger): AuthError {
  if (error instanceof AuthError) return error;
  if (error instanceof client.ResponseBodyError) {
    const code = ERROR_SHAPE.test(error.error) ? error.error : 'other';
    if (START_AGAIN.has(code)) return new AuthError('AUTH_OAUTH_STATE_INVALID');
    if (MISCONFIGURED.has(code)) {
      quietWarn(logger, 'auth.oauth_misconfigured', { provider, error: code });
    }
  }
  return new AuthError('AUTH_OAUTH_PROVIDER_ERROR');
}

function configuration(
  metadata: client.ServerMetadata,
  provider: OAuthProvider,
  oauth: OAuthClient,
  logger: AuthLogger,
  transport: OAuthTransport | undefined,
): client.Configuration {
  const config = new client.Configuration(metadata, oauth.clientId, {
    client_secret: oauth.clientSecret.reveal(),
  });
  config[client.customFetch] = createOAuthFetch({
    provider,
    logger,
    ...(transport === undefined ? {} : { transport }),
  });
  // Seconds; the guarded fetch holds every call to the same 5 s on its own.
  config.timeout = 5;
  return config;
}

async function githubJson(config: client.Configuration, token: string, path: string) {
  const response = await client.fetchProtectedResource(
    config,
    token,
    new URL(`${GITHUB_API}${path}`),
    'GET',
    undefined,
    new Headers(GITHUB_API_HEADERS),
  );
  if (!response.ok) throw new AuthError('AUTH_OAUTH_PROVIDER_ERROR');
  return await response.json();
}

function github(oauth: OAuthClient, logger: AuthLogger, transport?: OAuthTransport): Provider {
  const config = configuration(GITHUB, 'github', oauth, logger, transport);
  return {
    name: 'github',
    authorizationUrl(input) {
      return client.buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        scope: 'read:user user:email',
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      });
    },
    async complete(input) {
      try {
        const tokens = await client.authorizationCodeGrant(config, input.callback, {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.state,
        });
        const user = GitHubUser.parse(await githubJson(config, tokens.access_token, '/user'));
        const emails = GitHubEmails.parse(
          await githubJson(config, tokens.access_token, '/user/emails'),
        );
        // GET /user's email can be typed in by the person, so only the list counts, and
        // only its primary entry when GitHub verified it.
        const primary = emails.find((e) => e.primary && e.verified);
        return {
          subject: String(user.id),
          email: primary?.email ?? null,
          account: user.login,
          authTime: null,
        };
      } catch (error) {
        throw mapError('github', error, logger);
      }
    },
  };
}

function google(oauth: OAuthClient, logger: AuthLogger, transport?: OAuthTransport): Provider {
  const config = configuration(GOOGLE, 'google', oauth, logger, transport);
  // Without this the library trusts TLS to the token endpoint for the issuer and never
  // checks the signature. With it the JWKS is fetched, through the guarded fetch, and
  // cached on this configuration, which lives as long as the process.
  client.enableNonRepudiationChecks(config);
  return {
    name: 'google',
    authorizationUrl(input) {
      return client.buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        scope: 'openid email',
        state: input.state,
        nonce: input.nonce ?? '',
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
        // Step up must prove a fresh sign in, not a live Google session.
        ...(input.stepUp ? { prompt: 'login', max_age: '0' } : {}),
      });
    },
    async complete(input) {
      try {
        if (input.nonce === null) throw new AuthError('AUTH_OAUTH_STATE_INVALID');
        const tokens = await client.authorizationCodeGrant(config, input.callback, {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
        });
        const claims = GoogleClaims.parse(tokens.claims());
        const email = claims.email_verified === true ? (claims.email ?? null) : null;
        return {
          subject: claims.sub,
          email,
          account: claims.email ?? claims.sub,
          authTime: claims.auth_time ?? null,
        };
      } catch (error) {
        throw mapError('google', error, logger);
      }
    },
  };
}

export interface Providers {
  readonly github: Provider | null;
  readonly google: Provider | null;
}

// Built once per process: the Google configuration holds the JWKS cache.
export function createProviders(
  config: AuthConfig,
  logger: AuthLogger,
  transport?: OAuthTransport,
): Providers {
  return {
    github: config.oauth.github === null ? null : github(config.oauth.github, logger, transport),
    google: config.oauth.google === null ? null : google(config.oauth.google, logger, transport),
  };
}

export const redirectUriFor = (config: AuthConfig, provider: OAuthProvider): string =>
  new URL(`/auth/oauth/${provider}/callback`, config.appOrigin).href;
