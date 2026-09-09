import { createHash, timingSafeEqual } from "node:crypto";

import type { ApiConfig } from "./api-config.js";

/**
 * Constant-time string equality.
 *
 * Hashes both sides first rather than comparing raw buffers, so two inputs of
 * different length never short-circuit `timingSafeEqual`'s length check — a
 * fixed-size digest removes the length itself as a timing signal, not just
 * the content.
 */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();

  return timingSafeEqual(hashA, hashB);
}

/**
 * Thrown at startup when exactly one of the Basic Auth pair is configured.
 *
 * A username with no password (or vice versa) is not "auth half-enabled" —
 * it is a deployment that believes it is protected and isn't, which is worse
 * than the pair being absent altogether.
 */
export class IncompleteBasicAuthConfigError extends Error {
  public override readonly name = "IncompleteBasicAuthConfigError";

  public constructor() {
    super(
      "BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must both be set, or neither. " +
        "One was found without the other."
    );
  }
}

export interface BasicAuthCredentials {
  readonly user: string;
  readonly password: string;
}

/**
 * Resolve this deployment's Basic Auth credentials, or `undefined` if the
 * stopgap is deliberately off (e.g. local dev, or a deployment sitting behind
 * a VPN/private network instead).
 *
 * @throws {IncompleteBasicAuthConfigError} if only one of the pair is set.
 */
export function resolveBasicAuthCredentials(
  config: ApiConfig
): BasicAuthCredentials | undefined {
  const { BASIC_AUTH_USER: user, BASIC_AUTH_PASSWORD: password } = config;

  if (user === undefined && password === undefined) {
    return undefined;
  }

  if (user === undefined || password === undefined) {
    throw new IncompleteBasicAuthConfigError();
  }

  return { user, password };
}

const REALM = 'Basic realm="pattern-aware-seo-platform"';

/** Parse an `Authorization: Basic <base64>` header into user/password, or `undefined`. */
function parseBasicAuthHeader(
  header: string | undefined
): { readonly user: string; readonly password: string } | undefined {
  if (header === undefined || !header.startsWith("Basic ")) {
    return undefined;
  }

  let decoded: string;

  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString(
      "utf8"
    );
  } catch {
    return undefined;
  }

  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    return undefined;
  }

  return {
    user: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
}

/**
 * Check an incoming `Authorization` header against the configured pair.
 *
 * Returns `true` for a match. The caller is responsible for sending the
 * `401` + `WWW-Authenticate` response on a miss — kept here as a pure
 * function so it can be unit-tested without a Fastify request.
 */
export function checkBasicAuth(
  authorizationHeader: string | undefined,
  credentials: BasicAuthCredentials
): boolean {
  const parsed = parseBasicAuthHeader(authorizationHeader);

  if (parsed === undefined) {
    return false;
  }

  return (
    safeEqual(parsed.user, credentials.user) &&
    safeEqual(parsed.password, credentials.password)
  );
}

export const BASIC_AUTH_REALM = REALM;
