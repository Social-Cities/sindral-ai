import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../errors.js';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface UserTokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

export interface UserTokenVerifierOptions {
  supabaseUrl: string;
  /** Legacy HS256 secret. When absent the Supabase JWKS endpoint is used. */
  jwtSecret?: string;
}

function isAuthenticated(payload: JWTPayload): boolean {
  const aud = payload.aud;
  if (aud === 'authenticated') return true;
  if (Array.isArray(aud) && aud.includes('authenticated')) return true;
  return payload.role === 'authenticated';
}

const ASYMMETRIC_ALGS = ['RS256', 'ES256'];

export function createUserTokenVerifier(options: UserTokenVerifierOptions): UserTokenVerifier {
  // Supabase projects sign with either a legacy shared secret (HS256) or asymmetric keys
  // published at the JWKS endpoint (ES256/RS256). Pick the verifier from the token's own
  // `alg` header so both project generations work; the secret is only ever used for HS256.
  const secretKey = options.jwtSecret ? new TextEncoder().encode(options.jwtSecret) : null;
  let jwks: JWTVerifyGetKey | null = null;
  const getJwks = (): JWTVerifyGetKey => (jwks ??= createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', options.supabaseUrl)));

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        const { alg } = decodeProtectedHeader(token);
        if (alg === 'HS256') {
          if (!secretKey) throw new Error('HS256 token but no SUPABASE_JWT_SECRET configured');
          payload = (await jwtVerify(token, secretKey, { algorithms: ['HS256'] })).payload;
        } else if (alg && ASYMMETRIC_ALGS.includes(alg)) {
          payload = (await jwtVerify(token, getJwks(), { algorithms: ASYMMETRIC_ALGS })).payload;
        } else {
          throw new Error(`Unsupported JWT algorithm ${String(alg)}`);
        }
      } catch {
        throw unauthorized('Invalid or expired token');
      }
      if (!payload.sub || !isAuthenticated(payload)) throw unauthorized('Token is not an authenticated user token');
      const email = typeof payload.email === 'string' ? payload.email : null;
      return { id: payload.sub, email };
    },
  };
}

export function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token.trim();
}

/** Fastify `onRequest` hook enforcing a Supabase user token and attaching `request.user`. */
export function requireUser(verifier: UserTokenVerifier) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = extractBearer(request);
    if (!token) throw unauthorized('Missing bearer token');
    request.user = await verifier.verify(token);
  };
}
