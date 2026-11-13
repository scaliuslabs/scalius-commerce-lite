// src/server/middleware/admin-auth.ts
import type { MiddlewareHandler } from "hono";
import { pendingAdminAuthStep } from "@scalius/shared/admin-auth-step";
import { and, eq, sql } from "drizzle-orm";
import { autoSeedRbacIfNeeded, rbacSeedMarker } from "@scalius/core/auth/rbac/auto-seed";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { requireRoutePermission, routeRuleAllows } from "@scalius/core/auth/rbac/route-permissions";
import { routedApiPath } from "../utils/routed-path";
import { retryTransientD1 } from "@scalius/core/utils/transient-d1";
import { session as sessionTable, user as userTable } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { AgentGrantInactiveError } from "@scalius/core/errors";
import { UnauthorizedError, ForbiddenError } from "../utils/api-error";
import { getBearerToken, parseAgentCredential } from "../agent-access/pat";
import { resolveAgentPrincipalFromBearer, resolveAgentPrincipalFromGrant } from "../agent-access/principal";
import type { AgentPrincipal } from "../agent-access/types";
import { getAgentDispatchPrincipal, getOperationDispatchClearance, getPluginDispatchPrincipal } from "../agent-access/dispatch-context";
import { isAgentRiskAllowed } from "../agent-access/types";
import {
    enforceAgentRateLimit,
    enforceAgentRequestBoundary,
    writeDeniedAgentRequestAudit,
} from "./agent-request-boundary";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";
import { enforceDirectAgentRequestBodyLimit } from "./direct-agent-request-body";
import {
    SCANNER_COOKIE_NAME,
    isAllowedScannerApiRequest,
    parseCookie,
} from "@scalius/shared/scanner-auth";
import { readScannerSession, scannerPermissions } from "@scalius/core/auth/scanner-token-claims";
import { renewStaffSession } from "@scalius/core/auth/staff-session";
import { dashboardBasePathFromUrl } from "@scalius/shared/platform-config";

interface User {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    role: string;
    twoFactorEnabled?: boolean;
    mustChangePassword?: boolean;
    mustEnrollTwoFactor?: boolean;
    [key: string]: unknown;
}

interface Session {
    id: string;
    twoFactorVerified?: boolean | null;
    [key: string]: unknown;
}

const BETTER_AUTH_SESSION_COOKIE_NAMES = [
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
] as const;

function truthy(value: number | boolean | null | undefined): boolean {
    return value === true || value === 1;
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function constantTimeStringEqual(a: string, b: string): boolean {
    let mismatch = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
    }
    return mismatch === 0;
}

async function signBetterAuthCookieValue(value: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(value),
    );
    return encodeBase64(new Uint8Array(signature));
}

async function verifyBetterAuthSignedCookieValue(
    signedValue: string,
    secret: string | null | undefined,
): Promise<string | null> {
    const trimmedSecret = secret?.trim();
    if (!trimmedSecret) return null;

    const separatorIndex = signedValue.lastIndexOf(".");
    if (separatorIndex <= 0 || separatorIndex === signedValue.length - 1) {
        return null;
    }

    const token = signedValue.slice(0, separatorIndex).trim();
    const signature = signedValue.slice(separatorIndex + 1).trim();
    if (!token || !signature) return null;

    const expectedSignature = await signBetterAuthCookieValue(token, trimmedSecret);
    if (!constantTimeStringEqual(signature, expectedSignature)) return null;

    return token;
}

const BETTER_AUTH_DONT_REMEMBER_COOKIE_NAMES = [
    "better-auth.dont_remember",
    "__Secure-better-auth.dont_remember",
] as const;

interface SignedCookie {
    name: string;
    /** The cookie value exactly as the browser sent it. */
    rawValue: string;
    /** The value inside the signature. */
    token: string;
}

/** The first correctly signed Better Auth cookie under one of these names. */
async function readSignedBetterAuthCookie(
    cookieHeader: string | undefined,
    names: readonly string[],
    secret: string | undefined,
): Promise<SignedCookie | null> {
    const cookie = cookieHeader?.trim();
    if (!cookie) return null;

    for (const part of cookie.split(";")) {
        const [rawName, ...rawValueParts] = part.trim().split("=");
        if (!rawName || rawValueParts.length === 0) continue;
        if (!names.includes(rawName)) continue;

        const rawValue = rawValueParts.join("=");
        if (!rawValue) continue;

        try {
            const decoded = decodeURIComponent(rawValue);
            const token = await verifyBetterAuthSignedCookieValue(decoded, secret);
            if (token) return { name: rawName, rawValue, token };
        } catch {
            const token = await verifyBetterAuthSignedCookieValue(rawValue, secret);
            if (token) return { name: rawName, rawValue, token };
        }
    }

    return null;
}

/** The session token in a correctly signed Better Auth cookie, whether or not that session still exists. */
export async function getAdminSessionTokenFromCookieHeader(
    cookieHeader: string | undefined,
    secret: string | undefined,
): Promise<string | null> {
    return (await readSignedBetterAuthCookie(cookieHeader, BETTER_AUTH_SESSION_COOKIE_NAMES, secret))?.token ?? null;
}

export interface AdminSessionRead {
    user: User;
    session: Session;
    /** Set when this read extended the session: the session cookie again, ending with it. */
    renewedCookie?: string;
}

/**
 * The dashboard session behind a signed Better Auth cookie, or null. With
 * `renew`, a session due for it slides (staff-session.ts) and the result
 * carries the cookie to send back; a "don't remember me" sign-in ends with
 * its day, as Better Auth leaves it.
 */
export async function getAdminSessionFromCookieHeader(
    db: Database,
    cookieHeader: string | undefined,
    secret: string | undefined,
    options: { renew?: { cookiePath: string } } = {},
): Promise<AdminSessionRead | null> {
    const cookie = await readSignedBetterAuthCookie(cookieHeader, BETTER_AUTH_SESSION_COOKIE_NAMES, secret);
    if (!cookie) return null;
    const { token } = cookie;

    const row = await retryTransientD1(() =>
        db
            .select({
                sessionId: sessionTable.id,
                sessionExpiresAt: sessionTable.expiresAt,
                sessionCreatedAt: sessionTable.createdAt,
                twoFactorVerified: sessionTable.twoFactorVerified,
                id: userTable.id,
                email: userTable.email,
                name: userTable.name,
                image: userTable.image,
                role: userTable.role,
                isSuperAdmin: userTable.isSuperAdmin,
                twoFactorEnabled: userTable.twoFactorEnabled,
                mustChangePassword: userTable.mustChangePassword,
                mustEnrollTwoFactor: userTable.mustEnrollTwoFactor,
            })
            .from(sessionTable)
            .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
            .where(and(
                eq(sessionTable.token, token),
                sql`${sessionTable.expiresAt} > unixepoch()`,
                sql`(
                    ${userTable.banned} = 0
                    OR ${userTable.banned} IS NULL
                    OR (${userTable.banExpires} IS NOT NULL AND ${userTable.banExpires} <= unixepoch())
                )`,
            ))
            .get(),
    );

    if (!row) return null;

    let renewedCookie: string | undefined;
    if (
        options.renew &&
        !(await readSignedBetterAuthCookie(cookieHeader, BETTER_AUTH_DONT_REMEMBER_COOKIE_NAMES, secret))
    ) {
        const nowMs = Date.now();
        const expiresAt = await renewStaffSession(
            db,
            { id: row.sessionId, expiresAt: row.sessionExpiresAt, createdAt: row.sessionCreatedAt },
            nowMs,
        );
        if (expiresAt) {
            renewedCookie = [
                `${cookie.name}=${cookie.rawValue}`,
                `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - nowMs) / 1000))}`,
                `Path=${options.renew.cookiePath}`,
                "HttpOnly",
                "SameSite=Lax",
                ...(cookie.name.startsWith("__Secure-") ? ["Secure"] : []),
            ].join("; ");
        }
    }

    return {
        user: {
            id: row.id,
            email: row.email,
            name: row.name,
            image: row.image,
            role: row.role ?? "user",
            isSuperAdmin: truthy(row.isSuperAdmin),
            twoFactorEnabled: truthy(row.twoFactorEnabled),
            mustChangePassword: truthy(row.mustChangePassword),
            mustEnrollTwoFactor: truthy(row.mustEnrollTwoFactor),
        },
        session: {
            id: row.sessionId,
            twoFactorVerified: truthy(row.twoFactorVerified),
        },
        ...(renewedCookie ? { renewedCookie } : {}),
    };
}

/** The path Better Auth scopes the dashboard session cookie to. */
export function dashboardSessionCookiePath(env: { BETTER_AUTH_URL?: string }): string {
    return dashboardBasePathFromUrl(env.BETTER_AUTH_URL) || "/";
}

function hasNamedCookie(
    cookieHeader: string | undefined,
    name: string,
): boolean {
    return Boolean(parseCookie(cookieHeader, name));
}

function hasBetterAuthSessionCookie(cookieHeader: string | undefined): boolean {
    return BETTER_AUTH_SESSION_COOKIE_NAMES.some((name) =>
        hasNamedCookie(cookieHeader, name),
    );
}

function isTwoFactorCompletionRequest(
    pathname: string,
    method: string,
): boolean {
    return (
        (method === "GET" && pathname === "/api/v1/admin/auth/2fa/info") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/verify") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/method")
    );
}

function isPasswordOnboardingRequest(
    pathname: string,
    method: string,
): boolean {
    return (
        method === "POST" && pathname === "/api/v1/admin/auth/change-password"
    );
}

function isTwoFactorOnboardingRequest(
    pathname: string,
    method: string,
): boolean {
    return (
        (method === "GET" && pathname === "/api/v1/admin/auth/2fa/info") ||
        (method === "POST" && pathname === "/api/v1/admin/auth/2fa/method")
    );
}

/**
 * Admin Authentication & RBAC middleware for Hono
 *
 * This perfectly decouples the API from Astro's SSR middleware.
 * It accepts an active Better Auth session cookie from the dashboard frontend.
 * Scanner sessions are the only non-dashboard exception and are restricted to
 * the exact scanner workflow endpoints.
 */
export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {
    let user: User | null = null;
    let session: Session | null = null;
    let agentPrincipal: AgentPrincipal | null = c.get("agentPrincipal") ?? null;
    const dispatchPrincipal = getAgentDispatchPrincipal(c.env);
    const cookieHeader = c.req.header("Cookie");
    const hasBetterAuthCookie = hasBetterAuthSessionCookie(cookieHeader);
    const hasScannerCookie = hasNamedCookie(cookieHeader, SCANNER_COOKIE_NAME);
    const agentBearerToken = getBearerToken(c.req.header("Authorization"));
    const hasAgentCredential = Boolean(
        agentBearerToken && parseAgentCredential(agentBearerToken),
    );

    if (dispatchPrincipal && (cookieHeader?.trim() || c.req.header("Authorization")?.trim())) {
        throw new ForbiddenError(
            "Internal agent dispatch cannot be combined with request credentials",
        );
    }

    // An installed plugin calling an operation in-process (plugins/api-call.ts):
    // fresh plugin authority, plugin-available operations only, route RBAC.
    const pluginDispatch = getPluginDispatchPrincipal(c.env);
    if (pluginDispatch) {
        if (cookieHeader?.trim() || c.req.header("Authorization")?.trim() || agentPrincipal) {
            throw new ForbiddenError(
                "Internal plugin dispatch cannot be combined with request credentials",
            );
        }
        const { authorizePluginAdminRequest } = await import("../plugins/admin-request");
        await authorizePluginAdminRequest(c, pluginDispatch);
        await next();
        return;
    }

    // Agent and browser/scanner credentials are different principal classes.
    // Reject ambiguity before any session lookup or route authorization.
    if (hasAgentCredential && (hasBetterAuthCookie || hasScannerCookie)) {
        throw new ForbiddenError(
            "Cookie and agent credentials cannot be combined",
        );
    }

    // Direct CLI/PAT calls do not pass through the storefront-specific agent
    // middleware. Resolve them here, then keep the normal route mapping below.
    // Infrastructure JWTs and arbitrary Bearer tokens never enter this branch.
    if (hasAgentCredential && !agentPrincipal && agentBearerToken) {
        agentPrincipal = await resolveAgentPrincipalFromBearer(
            c.get("db"),
            agentBearerToken,
            c.env.AGENT_TOKEN_PEPPER,
        );
    }

    if (dispatchPrincipal && !agentPrincipal) {
        const freshPrincipal = await resolveAgentPrincipalFromGrant(c.get("db"), {
            grantId: dispatchPrincipal.grantId,
            credentialId: dispatchPrincipal.credentialId,
            resource: dispatchPrincipal.resource,
        });
        if (
            !freshPrincipal ||
            freshPrincipal.ownerUserId !== dispatchPrincipal.ownerUserId ||
            freshPrincipal.grantKind !== dispatchPrincipal.grantKind
        ) {
            throw new AgentGrantInactiveError();
        }
        agentPrincipal = freshPrincipal;
    }

    if (agentPrincipal) {
        const startedAt = Date.now();
        let operation: AgentOperationPolicy | null = null;
        let refusal: Response | null = null;
        if (!dispatchPrincipal) await enforceAgentRateLimit(c, agentPrincipal);
        try {
            if (agentPrincipal.resource !== "dashboard") {
                throw new ForbiddenError(
                    "Storefront credentials cannot access dashboard operations",
                );
            }
            c.set("agentPrincipal", agentPrincipal);
            c.set("user", {
                id: agentPrincipal.ownerUserId,
                email: "",
                name: "Agent connection owner",
                role: "agent",
                isSuperAdmin: agentPrincipal.isSuperAdmin,
            });
            c.set("adminPermissions", agentPrincipal.permissions);
            c.header("Cache-Control", "private, no-store");

            const pathname = routedApiPath(c);
            const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
            // A wrong method or path is 405/404 before any agent policy question.
            const routePermission = requireRoutePermission(pathname, method);
            const { resolveDirectAgentOperation } = await import("../agent-access/direct-operation");
            operation = resolveDirectAgentOperation(method, pathname);
            if (
                !operation ||
                (operation.exposure !== "execute" && operation.exposure !== "continuation") ||
                operation.surface !== "dashboard" ||
                !operation.principals.includes("admin") ||
                !isAgentRiskAllowed(agentPrincipal.riskCeiling, operation.risk)
            ) {
                throw new ForbiddenError(
                    "This dashboard operation is not available to direct agent credentials",
                );
            }
            if (!routeRuleAllows(routePermission, agentPrincipal.permissions, { anyAdmin: agentPrincipal.isSuperAdmin })) {
                throw new ForbiddenError(
                    "You do not have permission to perform this action",
                );
            }
            // Opt-in grant scopes (inbox, review moderation): only a Custom grant reaches them.
            const { requiresOptInGrantScope } = await import("../agent-access/grant-scopes");
            if (operation.rbac && requiresOptInGrantScope(operation.rbac) && agentPrincipal.preset !== "custom") {
                throw new ForbiddenError(
                    "This operation needs an opt-in grant scope: approve a Custom connection that selects it",
                );
            }
            if (!dispatchPrincipal) {
                await enforceDirectAgentRequestBodyLimit(c, operation);
            }
            // One confirmation gate for both lanes (MCP dispatch and direct REST).
            // It validates with the route's own schemas before it asks anyone.
            const gate = await import("../agent-access/confirm-gate");
            const clearance = dispatchPrincipal
                ? getOperationDispatchClearance(c.env) ?? { confirmed: false, dryRun: false }
                : null;
            if (clearance?.validateOnly) {
                // MCP asks whether the route would take this request before it asks a person; nothing runs.
                return (await gate.agentRequestValidationRefusal(c, operation, pathname)) ?? c.body(null, 204);
            }
            refusal = await gate.enforceAgentConfirmation(c, agentPrincipal, operation, pathname, clearance);
        } catch (error) {
            if (!dispatchPrincipal) {
                await writeDeniedAgentRequestAudit(c, agentPrincipal, operation, startedAt, error);
            }
            throw error;
        }
        if (refusal) {
            // The route's own answer to a request it would refuse, audited like the route's.
            const answer = refusal;
            if (dispatchPrincipal) return answer;
            await enforceAgentRequestBoundary(c, agentPrincipal, operation, async () => { c.res = answer; }, true);
            return c.res;
        }
        if (dispatchPrincipal) {
            // MCP dispatch already applies the per-step rate/audit boundary. The
            // Hono boundary still fresh-resolves and authorizes the operation.
            await next();
        } else {
            await enforceAgentRequestBoundary(c, agentPrincipal, operation, next, true);
        }
        return;
    }

    // 1. Try Better Auth Session Cookie. Verify the signed cookie locally before
    // touching D1 so raw/tampered cookies fail fast and cannot stall admin reads.
    if (hasBetterAuthCookie) {
        try {
            const db = c.get("db");
            const sessionResult = await getAdminSessionFromCookieHeader(
                db,
                cookieHeader,
                c.env.BETTER_AUTH_SECRET,
                { renew: { cookiePath: dashboardSessionCookiePath(c.env) } },
            );
            if (sessionResult?.user) {
                user = sessionResult.user;
                session = sessionResult.session;
                if (sessionResult.renewedCookie) {
                    c.header("Set-Cookie", sessionResult.renewedCookie, { append: true });
                }
            }
        } catch (error: unknown) {
            console.warn(
                "[AdminAuth] Session verification failed:",
                error instanceof Error ? error.message : "Unknown error",
            );
        }
    }

    // 2. Try Scanner Session Cookie (for warehouse scanner app)
    let scannerStaffId: string | null = null;
    if (!user && hasScannerCookie) {
        try {
            const sessionId = parseCookie(cookieHeader, SCANNER_COOKIE_NAME);
            const scanner = sessionId ? await readScannerSession(c.get("db"), sessionId) : null;
            if (scanner) {
                // A scanner acts with its staff member's current permissions
                // inside the scanner ceiling, under a synthetic identity so its
                // writes record the device, never the staff member's account.
                scannerStaffId = scanner.adminId;
                user = {
                    id: `scanner:${scanner.adminId}`,
                    email: "scanner@system",
                    name: scanner.adminName || "Scanner",
                    role: "scanner",
                };
            }
        } catch (error: unknown) {
            console.warn(
                "[AdminAuth] Scanner session verification failed:",
                error instanceof Error ? error.message : "Unknown error",
            );
        }
    }

    // If all methods fail, keep ordinary no-cookie probes quiet but preserve
    // a warning when a presented admin/scanner cookie could not authenticate.
    if (!user) {
        if (hasBetterAuthCookie || hasScannerCookie) {
            console.warn(
                "[AdminAuth] All auth methods failed for:",
                c.req.path,
            );
        }
        throw new UnauthorizedError(
            "Admin access requires a valid dashboard session cookie.",
        );
    }

    const pathname = routedApiPath(c);
    const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

    c.set("user", user);
    const db = c.get("db");
    let userPerms: Set<string>;

    if (scannerStaffId !== null) {
        // A scanner reaches only the scanner workflow endpoints, and on those
        // only what its staff member may do right now (scannerPermissions),
        // through the same route check as every staff request below.
        if (!isAllowedScannerApiRequest(pathname, c.req.method)) {
            throw new ForbiddenError(
                "Scanner sessions can only access scanner inventory endpoints",
            );
        }
        userPerms = scannerPermissions(await getUserPermissions(db, scannerStaffId));
    } else {
        if (session) {
            c.set("session", session);
        }

        const pendingStep = pendingAdminAuthStep(user, session);
        if (
            pendingStep === "set-password" &&
            !isPasswordOnboardingRequest(pathname, method)
        ) {
            throw new ForbiddenError("Password setup required before admin access");
        }

        if (
            pendingStep === "enroll-two-factor" &&
            !isTwoFactorOnboardingRequest(pathname, method)
        ) {
            throw new ForbiddenError(
                "Two-factor setup required before admin access",
            );
        }

        if (
            pendingStep === "verify-two-factor" &&
            !isTwoFactorCompletionRequest(pathname, method)
        ) {
            throw new ForbiddenError("Two-factor verification required");
        }

        // getUserPermissions already checks isSuperAdmin internally and returns ALL
        // permissions for super admins — no need for a separate isSuperAdmin() query.
        userPerms = await getUserPermissions(
            db,
            user.id,
            user.isSuperAdmin === true,
        );

        // Gate: must have at least one RBAC permission (super admins get all).
        // Do NOT fall back to legacy user.role check — RBAC is the source of truth.
        if (userPerms.size === 0) {
            throw new ForbiddenError("Admin access required");
        }

        // Seed-definition reconciliation is maintenance, not request authority.
        // Existing D1 grants remain the fail-closed source for ordinary admins,
        // while known super admins already resolve against the complete code-owned
        // permission list. Never make an authenticated read wait for hundreds of
        // idempotent role-grant repairs after a deploy or seed-marker expiry.
        const reconciliation = retryTransientD1(() =>
            autoSeedRbacIfNeeded(db, rbacSeedMarker(c.env)),
        );
        try {
            c.executionCtx.waitUntil(reconciliation);
        } catch {
            await reconciliation;
        }
    }

    c.set("adminPermissions", userPerms);

    // Fine-grained route permissions. A path or method no rule names is 404 or
    // 405 (with Allow), never 403. `allowAnyAdmin` routes are the signed-in
    // person's own account, which a scanner device does not hold.
    const routePermission = requireRoutePermission(pathname, method);
    if (!routeRuleAllows(routePermission, userPerms, { anyAdmin: scannerStaffId === null })) {
        throw new ForbiddenError(
            "You do not have permission to perform this action",
        );
    }

    // Passed all authentication and authorization checks
    return next();
};
