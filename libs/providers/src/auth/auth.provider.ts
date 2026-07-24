/**
 * Auth provider interface (Phase 1).
 *
 * Phone-number + OTP is the primary credential for this market (blueprint §8).
 * We INTEGRATE auth, never build it — but always behind this interface so the
 * concrete provider (Neon has no bundled auth, so e.g. Clerk / Auth.js / an
 * OTP+JWT service) is swappable. Authorization (`can()`) is separate and lives
 * in our own code — this interface only establishes *identity*, never
 * *permission* (§3.6, §10).
 */

export interface StartOtpRequest {
  /** E.164 phone number. PII — never logged (§3.10). */
  phone: string;
}

export interface StartOtpResult {
  /** Opaque challenge id the client echoes back on verify. */
  challengeId: string;
  expiresInSeconds: number;
  /**
   * Populated ONLY in dev (AUTH_EXPOSE_OTP=true), never in production — real
   * OTP delivery is over SMS (Communications, Phase 3). Lets us exercise the
   * full auth flow before the SMS channel exists.
   */
  devCode?: string;
}

export interface VerifyOtpRequest {
  challengeId: string;
  code: string;
}

export interface AuthSession {
  userId: string;
  /** Signed token the client presents on subsequent requests. */
  accessToken: string;
  /** Long-lived signed refresh token used to request new access tokens. */
  refreshToken: string;
  expiresAt: Date;
  /**
   * True only when this call created the user account (never on a returning
   * login or a token refresh). The API layer uses this to start the
   * account's one-time free trial exactly once, at genuine signup.
   */
  isNewUser: boolean;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

/** The verified identity extracted from a presented access token. */
export interface AuthenticatedActor {
  userId: string;
  phoneVerified: boolean;
}

export interface AuthProvider {
  startOtp(request: StartOtpRequest): Promise<StartOtpResult>;
  verifyOtp(request: VerifyOtpRequest): Promise<AuthSession>;
  refreshToken(request: RefreshTokenRequest): Promise<AuthSession>;
  /**
   * Validate a presented access token and return the actor, or null if the
   * token is invalid/expired. Callers MUST treat null as "unauthenticated",
   * never as a trusted default.
   */
  verifyAccessToken(token: string): Promise<AuthenticatedActor | null>;
}
