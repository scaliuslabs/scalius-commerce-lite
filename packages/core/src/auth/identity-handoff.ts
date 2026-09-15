/**
 * Trusted external identity handoff for the dashboard (opt-in).
 *
 * Operators who front many stores with their own identity provider mint a
 * short-lived JWT and open `GET <dashboardUrl>/api/auth/handoff?token=...`.
 * The dashboard verifies the token, upserts the administrator by verified
 * e-mail with the mapped role, creates a normal Better Auth session, records
 * an audit row, and redirects into the dashboard. The companion
 * `POST /api/auth/handoff/revoke` revokes a user's sessions (and optionally
 * suspends the account) when the external identity is removed.
 *
 * Token contract (documented in docs/AUTOMATED-DEPLOYMENTS.md):
 *
 *   - `iss` equals the configured issuer, `aud` the configured audience;
 *   - `iat` and `exp` are required, `exp - iat` is at most 120 seconds, and the
 *     token is rejected more than 30 seconds after `exp`;
 *   - `jti` is required and single-use: the audit row keyed by its hash is the
 *     replay guard;
 *   - `purpose` is `dashboard-handoff` or `dashboard-revoke`;
 *   - `email` is the administrator's verified address (`email_verified`, when
 *     present, must be `true`); `name` is optional;
 *   - `role` maps to dashboard authority: `owner` grants super-admin, any other
 *     value must equal an existing role name (`super_admin`, `manager`,
 *     `sales_rep`, `content_editor`, `product_specialist`, or a custom role).
 *
 * Signing: HS256 with the HKDF-derived `IDENTITY_HANDOFF_SECRET` (the operator
 * derives the same value from `SCALIUS_SECRET`), or an asymmetric algorithm
 * verified against the configured JWKS URL. Nothing here reads Wrangler vars;
 * the configuration is the Platform settings document.
 */

import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, gt, lt } from "drizzle-orm";
import type { BetterAuthPlugin } from "better-auth";
import type { BatchItem } from "drizzle-orm/batch";
import { createRemoteJWKSet, customFetch, jwtVerify, SignJWT, type JWTPayload } from "jose";
import * as z from "zod";

import { safeBatch, type Database } from "@scalius/database/client";
import {
  account,
  adminIdentityHandoffEvents,
  roles,
  session as sessionTable,
  user,
  userRoles,
} from "@scalius/database/schema";
import {
  EMPTY_IDENTITY_HANDOFF_CONFIG,
  joinPlatformUrl,
  type IdentityHandoffConfig,
} from "@scalius/shared/platform-config";

import { clearPermissionCache } from "./rbac/helpers";

export const IDENTITY_HANDOFF_PLUGIN_ID = "identity-handoff";
export const IDENTITY_HANDOFF_PATH = "/handoff";
export const IDENTITY_HANDOFF_REVOKE_PATH = "/handoff/revoke";
/** Longest lifetime (`exp - iat`) a handoff token may declare. */
export const IDENTITY_HANDOFF_MAX_TOKEN_LIFETIME_SECONDS = 120;
/** Clock skew tolerated around `exp`, `nbf`, and `iat`. */
export const IDENTITY_HANDOFF_CLOCK_TOLERANCE_SECONDS = 30;
export const IDENTITY_HANDOFF_OWNER_ROLE = "owner";
export const IDENTITY_HANDOFF_ACCOUNT_PROVIDER = "identity-handoff";
/** Audit rows stay at least this long after their token expired. */
export const IDENTITY_HANDOFF_AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const IDENTITY_HANDOFF_RATE_LIMIT = { window: 60, max: 10 } as const;
const HS256_ALGORITHMS = ["HS256"] as const;
const JWKS_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"] as const;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_USER_AGENT_LENGTH = 256;

type SqliteBatchItem = BatchItem<"sqlite">;

export type IdentityHandoffPurpose = "dashboard-handoff" | "dashboard-revoke";

export interface IdentityHandoffClaims {
  purpose: IdentityHandoffPurpose;
  jti: string;
  subject: string | null;
  email: string;
  name: string | null;
  role: string | null;
  suspend: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface IdentityHandoffVerifyOptions {
  config: IdentityHandoffConfig;
  /** Derived `IDENTITY_HANDOFF_SECRET`; required unless a JWKS URL is set. */
  hmacSecret: string | null | undefined;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => Date;
  /** Injectable JWKS fetcher for tests. */
  fetch?: typeof fetch;
}

export class IdentityHandoffError extends Error {
  readonly status: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";
  readonly code: string;

  constructor(
    status: IdentityHandoffError["status"],
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "IdentityHandoffError";
    this.status = status;
    this.code = code;
  }
}

const encoder = new TextEncoder();

function unauthorized(code: string, message: string): IdentityHandoffError {
  return new IdentityHandoffError("UNAUTHORIZED", code, message);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readString(value: unknown, max = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

const emailSchema = z.string().trim().min(3).max(254).email();

/** Hash used for the single-use ledger; purpose-scoped so a revoke token cannot replay a handoff. */
export async function hashHandoffJti(kind: "handoff" | "revoke", jti: string): Promise<string> {
  return sha256Hex(`${kind}:${jti}`);
}

function readClaims(payload: JWTPayload): IdentityHandoffClaims {
  const purpose = payload.purpose;
  if (purpose !== "dashboard-handoff" && purpose !== "dashboard-revoke") {
    throw unauthorized("HANDOFF_PURPOSE_INVALID", "The token purpose is not a dashboard handoff.");
  }
  const jti = readString(payload.jti, 256);
  if (!jti || jti.length < 8) {
    throw unauthorized("HANDOFF_JTI_MISSING", "The token must carry a unique jti of at least 8 characters.");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw unauthorized("HANDOFF_LIFETIME_INVALID", "The token must carry iat and exp.");
  }
  if (payload.exp - payload.iat > IDENTITY_HANDOFF_MAX_TOKEN_LIFETIME_SECONDS || payload.exp <= payload.iat) {
    throw unauthorized(
      "HANDOFF_LIFETIME_INVALID",
      `The token lifetime must be between 1 and ${IDENTITY_HANDOFF_MAX_TOKEN_LIFETIME_SECONDS} seconds.`,
    );
  }
  const emailResult = emailSchema.safeParse(payload.email);
  if (!emailResult.success) {
    throw unauthorized("HANDOFF_EMAIL_INVALID", "The token must carry the administrator's e-mail address.");
  }
  if (payload.email_verified !== undefined && payload.email_verified !== true) {
    throw unauthorized("HANDOFF_EMAIL_UNVERIFIED", "The token e-mail address is not verified.");
  }
  return {
    purpose,
    jti,
    subject: readString(payload.sub, 256),
    email: emailResult.data.toLowerCase(),
    name: readString(payload.name, 200),
    role: readString(payload.role, 100)?.toLowerCase() ?? null,
    suspend: payload.suspend === true,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/**
 * Verifies a handoff or revoke token against the Platform configuration and
 * returns its normalized claims. Every failure is an `IdentityHandoffError`
 * with a stable code; token material never enters the message.
 */
export async function verifyIdentityHandoffToken(
  token: string,
  options: IdentityHandoffVerifyOptions,
): Promise<IdentityHandoffClaims> {
  const { config } = options;
  if (!config.enabled) {
    throw new IdentityHandoffError("NOT_FOUND", "HANDOFF_DISABLED", "Identity handoff is not enabled.");
  }
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw unauthorized("HANDOFF_TOKEN_INVALID", "The handoff token is missing or malformed.");
  }

  const currentDate = options.now?.() ?? new Date();
  const verifyOptions = {
    issuer: config.issuer,
    audience: config.audience,
    clockTolerance: IDENTITY_HANDOFF_CLOCK_TOLERANCE_SECONDS,
    maxTokenAge: IDENTITY_HANDOFF_MAX_TOKEN_LIFETIME_SECONDS,
    requiredClaims: ["iat", "exp", "jti", "email", "purpose"],
    currentDate,
  };

  let payload: JWTPayload;
  try {
    if (config.jwksUrl) {
      const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        ...(options.fetch ? { [customFetch]: options.fetch } : {}),
      });
      payload = (await jwtVerify(token, jwks, { ...verifyOptions, algorithms: [...JWKS_ALGORITHMS] })).payload;
    } else {
      if (!options.hmacSecret) {
        throw unauthorized("HANDOFF_KEY_UNAVAILABLE", "The identity handoff signing key is not available.");
      }
      payload = (await jwtVerify(token, encoder.encode(options.hmacSecret), {
        ...verifyOptions,
        algorithms: [...HS256_ALGORITHMS],
      })).payload;
    }
  } catch (error) {
    if (error instanceof IdentityHandoffError) throw error;
    throw unauthorized("HANDOFF_TOKEN_INVALID", "The handoff token could not be verified.");
  }

  return readClaims(payload);
}

export interface MintIdentityHandoffTokenInput {
  hmacSecret: string;
  issuer: string;
  audience: string;
  purpose: IdentityHandoffPurpose;
  email: string;
  jti: string;
  subject?: string;
  name?: string;
  role?: string;
  suspend?: boolean;
  /** Unix seconds; defaults to now. */
  issuedAt?: number;
  /** Seconds; defaults to 60. */
  lifetimeSeconds?: number;
  emailVerified?: boolean;
}

/**
 * Mints an HS256 handoff token with the derived secret. Used by operators'
 * tooling (`scripts/mint-identity-handoff-token.mjs`) and by tests.
 */
export async function mintIdentityHandoffToken(input: MintIdentityHandoffTokenInput): Promise<string> {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeSeconds ?? 60;
  const claims: Record<string, unknown> = {
    purpose: input.purpose,
    email: input.email,
    ...(input.emailVerified === undefined ? {} : { email_verified: input.emailVerified }),
    ...(input.name ? { name: input.name } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.suspend ? { suspend: true } : {}),
  };
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setJti(input.jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetime);
  if (input.subject) builder = builder.setSubject(input.subject);
  return builder.sign(encoder.encode(input.hmacSecret));
}

export interface IdentityHandoffRequestContext {
  clientIp: string | null;
  userAgent: string | null;
}

export interface ResolvedRoleMapping {
  isSuperAdmin: boolean;
  roleId: string | null;
  roleName: string | null;
}

async function resolveRoleMapping(db: Database, role: string | null): Promise<ResolvedRoleMapping> {
  if (!role) {
    throw new IdentityHandoffError("FORBIDDEN", "HANDOFF_ROLE_MISSING", "The token must carry a dashboard role.");
  }
  if (role === IDENTITY_HANDOFF_OWNER_ROLE) {
    return { isSuperAdmin: true, roleId: null, roleName: IDENTITY_HANDOFF_OWNER_ROLE };
  }
  const match = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.name, role))
    .get();
  if (!match) {
    throw new IdentityHandoffError("FORBIDDEN", "HANDOFF_ROLE_UNKNOWN", "The token role does not match a dashboard role.");
  }
  return { isSuperAdmin: false, roleId: match.id, roleName: match.name };
}

async function claimHandoffEvent(
  db: Database,
  input: {
    kind: "handoff" | "revoke";
    claims: IdentityHandoffClaims;
    issuer: string;
    request: IdentityHandoffRequestContext;
    now: Date;
  },
): Promise<string> {
  const eventId = `hnd_${crypto.randomUUID()}`;
  const jtiHash = await hashHandoffJti(input.kind, input.claims.jti);
  const inserted = await db
    .insert(adminIdentityHandoffEvents)
    .values({
      id: eventId,
      kind: input.kind,
      jtiHash,
      issuer: input.issuer,
      subject: input.claims.subject,
      email: input.claims.email,
      userId: null,
      role: input.claims.role,
      outcome: "claimed",
      clientIp: input.request.clientIp,
      userAgent: input.request.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      tokenExpiresAt: input.claims.expiresAt,
      createdAt: Math.floor(input.now.getTime() / 1000),
    })
    .onConflictDoNothing()
    .returning({ id: adminIdentityHandoffEvents.id });
  if (!inserted[0]?.id) {
    throw unauthorized("HANDOFF_TOKEN_REPLAYED", "This handoff token was already used.");
  }
  return eventId;
}

async function recordHandoffOutcome(
  db: Database,
  eventId: string,
  outcome: string,
  userId: string | null,
): Promise<void> {
  await db
    .update(adminIdentityHandoffEvents)
    .set({ outcome, userId })
    .where(eq(adminIdentityHandoffEvents.id, eventId));
}

/**
 * Deletes audit rows whose token expired more than the retention window ago.
 * Bounded by the expiry index; called from scheduled maintenance.
 */
export async function pruneExpiredIdentityHandoffEvents(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = Math.floor(now.getTime() / 1000) - IDENTITY_HANDOFF_AUDIT_RETENTION_SECONDS;
  const deleted = await db
    .delete(adminIdentityHandoffEvents)
    .where(lt(adminIdentityHandoffEvents.tokenExpiresAt, cutoff))
    .returning({ id: adminIdentityHandoffEvents.id });
  return deleted.length;
}

export interface PerformIdentityHandoffInput {
  claims: IdentityHandoffClaims;
  config: IdentityHandoffConfig;
  request: IdentityHandoffRequestContext;
  /** Shared auth KV holding cached effective permissions. */
  permissionCache?: KVNamespace;
  now?: () => Date;
}

export interface IdentityHandoffResult {
  userId: string;
  created: boolean;
  eventId: string;
  mapping: ResolvedRoleMapping;
}

/**
 * Upserts the administrator for a verified handoff token. The audit row is
 * claimed first so a replay can never reach the user or session writes.
 */
export async function performIdentityHandoff(
  db: Database,
  input: PerformIdentityHandoffInput,
): Promise<IdentityHandoffResult> {
  const { claims } = input;
  if (claims.purpose !== "dashboard-handoff") {
    throw unauthorized("HANDOFF_PURPOSE_INVALID", "The token purpose is not a dashboard handoff.");
  }
  const now = input.now?.() ?? new Date();
  const eventId = await claimHandoffEvent(db, {
    kind: "handoff",
    claims,
    issuer: input.config.issuer,
    request: input.request,
    now,
  });

  try {
    const mapping = await resolveRoleMapping(db, claims.role);
    const existing = await db
      .select({
        id: user.id,
        name: user.name,
        banned: user.banned,
        banExpires: user.banExpires,
        isSuperAdmin: user.isSuperAdmin,
      })
      .from(user)
      .where(eq(user.email, claims.email))
      .get();

    if (existing) {
      const suspended = existing.banned && (!existing.banExpires || existing.banExpires.getTime() > now.getTime());
      if (suspended) {
        throw new IdentityHandoffError("FORBIDDEN", "HANDOFF_USER_SUSPENDED", "This administrator is suspended.");
      }
      const statements: SqliteBatchItem[] = [
        db
          .update(user)
          .set({
            name: claims.name ?? existing.name,
            emailVerified: true,
            role: "admin",
            isSuperAdmin: mapping.isSuperAdmin,
            mustChangePassword: false,
            mustEnrollTwoFactor: false,
            updatedAt: now,
          })
          .where(eq(user.id, existing.id)),
      ];
      if (mapping.roleId) {
        // The identity provider's role claim is authoritative for handoff users.
        statements.push(
          db.delete(userRoles).where(eq(userRoles.userId, existing.id)),
          db.insert(userRoles).values({
            id: crypto.randomUUID(),
            userId: existing.id,
            roleId: mapping.roleId,
            assignedBy: null,
            createdAt: now,
          }),
        );
      }
      await safeBatch(db, statements);
      await clearPermissionCache(existing.id, input.permissionCache);
      await recordHandoffOutcome(db, eventId, "signed_in", existing.id);
      return { userId: existing.id, created: false, eventId, mapping };
    }

    const userId = crypto.randomUUID();
    const statements: SqliteBatchItem[] = [
      db.insert(user).values({
        id: userId,
        name: claims.name ?? claims.email,
        email: claims.email,
        emailVerified: true,
        role: "admin",
        isSuperAdmin: mapping.isSuperAdmin,
        mustChangePassword: false,
        mustEnrollTwoFactor: false,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(account).values({
        id: crypto.randomUUID(),
        userId,
        accountId: claims.subject ?? claims.email,
        providerId: IDENTITY_HANDOFF_ACCOUNT_PROVIDER,
        issuer: input.config.issuer,
        createdAt: now,
        updatedAt: now,
      }),
    ];
    if (mapping.roleId) {
      statements.push(
        db.insert(userRoles).values({
          id: crypto.randomUUID(),
          userId,
          roleId: mapping.roleId,
          assignedBy: null,
          createdAt: now,
        }),
      );
    }
    await safeBatch(db, statements);
    await recordHandoffOutcome(db, eventId, "user_created", userId);
    return { userId, created: true, eventId, mapping };
  } catch (error) {
    const outcome = error instanceof IdentityHandoffError ? `rejected:${error.code}` : "failed";
    await recordHandoffOutcome(db, eventId, outcome, null).catch(() => undefined);
    throw error;
  }
}

export interface IdentityRevocationResult {
  userId: string;
  sessionsRevoked: number;
  suspended: boolean;
  suspensionRefused: "store_owner" | null;
  eventId: string;
}

/**
 * Revokes every session of the administrator named by a verified revoke
 * token and optionally suspends the account. The store owner (super admin)
 * keeps the same protection as `dashboard.team.users.set_suspension`.
 */
export async function performIdentityRevocation(
  db: Database,
  input: PerformIdentityHandoffInput,
): Promise<IdentityRevocationResult> {
  const { claims } = input;
  if (claims.purpose !== "dashboard-revoke") {
    throw unauthorized("HANDOFF_PURPOSE_INVALID", "The token purpose is not a dashboard revocation.");
  }
  const now = input.now?.() ?? new Date();
  const eventId = await claimHandoffEvent(db, {
    kind: "revoke",
    claims,
    issuer: input.config.issuer,
    request: input.request,
    now,
  });

  try {
    const target = await db
      .select({ id: user.id, isSuperAdmin: user.isSuperAdmin })
      .from(user)
      .where(eq(user.email, claims.email))
      .get();
    if (!target) {
      throw new IdentityHandoffError("NOT_FOUND", "HANDOFF_USER_NOT_FOUND", "No dashboard account uses that e-mail address.");
    }
    const revoked = await db
      .delete(sessionTable)
      .where(eq(sessionTable.userId, target.id))
      .returning({ id: sessionTable.id });

    let suspended = false;
    let suspensionRefused: IdentityRevocationResult["suspensionRefused"] = null;
    if (claims.suspend) {
      if (target.isSuperAdmin) {
        suspensionRefused = "store_owner";
      } else {
        await db
          .update(user)
          .set({
            banned: true,
            banReason: "Suspended by the identity provider",
            banExpires: null,
            updatedAt: now,
          })
          .where(and(eq(user.id, target.id), eq(user.isSuperAdmin, false)));
        suspended = true;
      }
    }
    await clearPermissionCache(target.id, input.permissionCache);
    await recordHandoffOutcome(
      db,
      eventId,
      suspended ? "sessions_revoked_and_suspended" : "sessions_revoked",
      target.id,
    );
    return { userId: target.id, sessionsRevoked: revoked.length, suspended, suspensionRefused, eventId };
  } catch (error) {
    const outcome = error instanceof IdentityHandoffError ? `rejected:${error.code}` : "failed";
    await recordHandoffOutcome(db, eventId, outcome, null).catch(() => undefined);
    throw error;
  }
}

/** Counts unexpired audit rows for a user; exposed for readiness/diagnostics. */
export async function countRecentIdentityHandoffs(db: Database, userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: adminIdentityHandoffEvents.id })
    .from(adminIdentityHandoffEvents)
    .where(and(
      eq(adminIdentityHandoffEvents.userId, userId),
      gt(adminIdentityHandoffEvents.createdAt, Math.floor(since.getTime() / 1000)),
    ));
  return rows.length;
}

function toApiError(error: unknown): never {
  if (error instanceof IdentityHandoffError) {
    throw new APIError(error.status, { message: error.message, code: error.code });
  }
  throw error;
}

/**
 * The slice of the Better Auth endpoint context the plugin uses. The library's
 * handler typing does not survive this repository's isolated type resolution,
 * so the shape is pinned here and checked against the calls below.
 */
interface HandoffEndpointContext<Query, Body> {
  query: Query;
  body: Body;
  request?: Request;
  context: {
    internalAdapter: {
      createSession(
        userId: string,
        dontRememberMe?: boolean,
        override?: Record<string, unknown>,
      ): Promise<Record<string, unknown> | null>;
      findUserById(id: string): Promise<Record<string, unknown> | null>;
    };
  };
  json<T>(data: T): T;
  redirect(url: string): unknown;
}

export interface IdentityHandoffPluginOptions {
  db: Database;
  config: IdentityHandoffConfig | undefined;
  hmacSecret: string | null | undefined;
  /** Full dashboard URL (origin plus optional base path) for the post-handoff redirect. */
  dashboardUrl: string | undefined;
  permissionCache?: KVNamespace;
}

/**
 * Better Auth plugin exposing `GET /handoff` and `POST /handoff/revoke` under
 * the dashboard's auth base path. Both endpoints are unauthenticated by
 * design: the signed token is the credential. They are rate limited like
 * sign-in and answer 404 while the handoff is disabled.
 */
export function identityHandoff(options: IdentityHandoffPluginOptions): BetterAuthPlugin {
  const config = options.config ?? EMPTY_IDENTITY_HANDOFF_CONFIG;

  function requestContext(request: Request | undefined): IdentityHandoffRequestContext {
    return {
      clientIp: request?.headers.get("cf-connecting-ip") ?? null,
      userAgent: request?.headers.get("user-agent") ?? null,
    };
  }

  return {
    id: IDENTITY_HANDOFF_PLUGIN_ID,
    rateLimit: [
      {
        pathMatcher: (path: string) =>
          path === IDENTITY_HANDOFF_PATH || path === IDENTITY_HANDOFF_REVOKE_PATH,
        window: IDENTITY_HANDOFF_RATE_LIMIT.window,
        max: IDENTITY_HANDOFF_RATE_LIMIT.max,
      },
    ],
    endpoints: {
      identityHandoff: createAuthEndpoint(
        IDENTITY_HANDOFF_PATH,
        {
          method: "GET",
          // Deliberately permissive: a store that never enabled handoff must
          // answer 404, not a schema error that proves the route exists. The
          // verifier below rejects a missing or oversized token itself.
          query: z.object({ token: z.string().max(MAX_TOKEN_LENGTH).optional() }).optional(),
          metadata: {
            openapi: {
              description: "Sign in with an operator-minted identity handoff token",
              responses: { "302": { description: "Redirects into the dashboard" } },
            },
          },
        },
        async (ctx: HandoffEndpointContext<{ token?: string } | undefined, undefined>) => {
          try {
            const claims = await verifyIdentityHandoffToken(ctx.query?.token ?? "", {
              config,
              hmacSecret: options.hmacSecret,
            });
            const result = await performIdentityHandoff(options.db, {
              claims,
              config,
              request: requestContext(ctx.request),
              permissionCache: options.permissionCache,
            });
            const session = await ctx.context.internalAdapter.createSession(
              result.userId,
              false,
              { twoFactorVerified: true },
            );
            if (!session) {
              throw new IdentityHandoffError("CONFLICT", "HANDOFF_SESSION_FAILED", "The session could not be created.");
            }
            const signedInUser = await ctx.context.internalAdapter.findUserById(result.userId);
            if (!signedInUser) {
              throw new IdentityHandoffError("CONFLICT", "HANDOFF_SESSION_FAILED", "The session could not be created.");
            }
            await setSessionCookie(ctx as never, { session, user: signedInUser } as never);
            const destination = joinPlatformUrl(options.dashboardUrl ?? "", "/admin") || "/admin";
            throw ctx.redirect(destination);
          } catch (error) {
            return toApiError(error);
          }
        },
      ),
      identityHandoffRevoke: createAuthEndpoint(
        IDENTITY_HANDOFF_REVOKE_PATH,
        {
          method: "POST",
          // Permissive for the same reason as the sign-in endpoint above.
          body: z.object({ token: z.string().max(MAX_TOKEN_LENGTH).optional() }).optional(),
          metadata: {
            openapi: {
              description: "Revoke an administrator's dashboard sessions with an operator-minted token",
              responses: { "200": { description: "Sessions revoked" } },
            },
          },
        },
        async (ctx: HandoffEndpointContext<undefined, { token?: string } | undefined>) => {
          try {
            const claims = await verifyIdentityHandoffToken(ctx.body?.token ?? "", {
              config,
              hmacSecret: options.hmacSecret,
            });
            const result = await performIdentityRevocation(options.db, {
              claims,
              config,
              request: requestContext(ctx.request),
              permissionCache: options.permissionCache,
            });
            return ctx.json({
              userId: result.userId,
              sessionsRevoked: result.sessionsRevoked,
              suspended: result.suspended,
              suspensionRefused: result.suspensionRefused,
            });
          } catch (error) {
            return toApiError(error);
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
