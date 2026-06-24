// src/server/routes/admin/auth-management.ts
// Admin OpenAPI routes for auth management (users, profile, 2FA, setup).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { getCookies, parseSetCookieHeader, splitSetCookieHeader } from "better-auth/cookies";
import type { Database } from "@scalius/database/client";
import { user, roles, userRoles, userPermissions, permissions, session as sessionTable } from "@scalius/database/schema";
import {
    claimAdminSetup,
    completeAdminSetupClaimWithUserPromotion,
    createAuth,
    enforceAdminSetupRateLimit,
    markAdminSetupClaimCompleted,
    markAdminSetupClaimFailed,
    type ClaimedAdminSetup,
} from "@scalius/core/auth";
import { assignRoleToUser } from "@scalius/core/auth/rbac/helpers";

import { ok, created } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError, NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "../../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

type BetterAuthHeaders = Headers & { getSetCookie?: () => string[] };
type BetterAuthHeadersResult<T> = { response: T; headers?: Headers };

function getSetCookieValues(headers?: Headers): string[] {
    if (!headers) return [];
    const headersWithCookies = headers as BetterAuthHeaders;
    if (typeof headersWithCookies.getSetCookie === "function") {
        return headersWithCookies.getSetCookie();
    }
    return splitSetCookieHeader(headers.get("set-cookie") ?? "");
}

function appendBetterAuthSetCookies(c: Parameters<typeof ok>[0], headers?: Headers): void {
    for (const cookie of getSetCookieValues(headers)) {
        c.header("Set-Cookie", cookie, { append: true });
    }
}

function getAuthSessionCookieName(auth: unknown): string {
    const options = (auth as { options?: Parameters<typeof getCookies>[0] }).options;
    if (!options) return "better-auth.session_token";
    return getCookies(options).sessionToken.name;
}

function getSessionTokenFromSetCookie(headers: Headers | undefined, auth: unknown): string | undefined {
    const cookieNames = new Set([
        getAuthSessionCookieName(auth),
        "better-auth.session_token",
        "__Secure-better-auth.session_token",
    ]);

    for (const cookie of getSetCookieValues(headers)) {
        const parsed = parseSetCookieHeader(cookie);
        for (const name of cookieNames) {
            const rawValue = parsed.get(name)?.value;
            const token = rawValue?.split(".")[0];
            if (token) return token;
        }
    }
    return undefined;
}

function generateBootstrapPassword(length = 32): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let password = "";
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        password += chars[(randomValues[i] ?? 0) % chars.length];
    }
    return password;
}

function adminPrincipalPredicate() {
    return or(
        eq(user.role, "admin"),
        eq(user.isSuperAdmin, true),
        isNotNull(userRoles.id),
        isNotNull(userPermissions.id),
    );
}

// ─────────────────────────────────────────
// Admin Users Management
// ─────────────────────────────────────────

const adminUserSchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    twoFactorEnabled: z.boolean(),
    mustChangePassword: z.boolean(),
    mustEnrollTwoFactor: z.boolean(),
    isSuperAdmin: z.boolean(),
    createdAt: z.union([z.string(), z.number()]),
    roles: z.array(z.object({ id: z.string(), name: z.string(), displayName: z.string() })),
    overrides: z.object({ grants: z.array(z.string()), denials: z.array(z.string()) }),
}).passthrough();

const listUsersRoute = createRoute({
    method: "get",
    path: "/users",
    tags: ["Admin - Auth Management"],
    summary: "List all admin users",
    responses: {
        200: { description: "Admin user list", content: { "application/json": { schema: successEnvelope(z.object({ users: z.array(adminUserSchema) })) } } },
        ...errorResponses,
    }
});

app.openapi(listUsersRoute, async (c) => {
    try {
        const db = c.get("db");

        const adminUsers = await db
            .selectDistinct({
                id: user.id,
                name: user.name,
                email: user.email,
                emailVerified: user.emailVerified,
                image: user.image,
                twoFactorEnabled: user.twoFactorEnabled,
                mustChangePassword: user.mustChangePassword,
                mustEnrollTwoFactor: user.mustEnrollTwoFactor,
                isSuperAdmin: user.isSuperAdmin,
                createdAt: user.createdAt
            })
            .from(user)
            .leftJoin(userRoles, eq(userRoles.userId, user.id))
            .leftJoin(userPermissions, and(
                eq(userPermissions.userId, user.id),
                eq(userPermissions.granted, true),
            ))
            .where(adminPrincipalPredicate());

        const usersWithRoles = await Promise.all(
            adminUsers.map(async (adminUser) => {
                const userRoleData = await db
                    .select({
                        id: roles.id,
                        name: roles.name,
                        displayName: roles.displayName
                    })
                    .from(userRoles)
                    .innerJoin(roles, eq(userRoles.roleId, roles.id))
                    .where(eq(userRoles.userId, adminUser.id));

                const overrides = await db
                    .select({
                        permissionName: permissions.name,
                        granted: userPermissions.granted
                    })
                    .from(userPermissions)
                    .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
                    .where(eq(userPermissions.userId, adminUser.id));

                const grants = overrides.filter((o) => o.granted).map((o) => o.permissionName);
                const denials = overrides.filter((o) => !o.granted).map((o) => o.permissionName);

                return {
                    ...adminUser,
                    roles: userRoleData,
                    overrides: { grants, denials }
                };
            })
        );

        return ok(c, { users: usersWithRoles });
    } catch (error: unknown) {
        console.error("Get admin users error:", error);
        throw error;
    }
});

const createAdminSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    roleId: z.string().optional()
});

const createUserRoute = createRoute({
    method: "post",
    path: "/users",
    tags: ["Admin - Auth Management"],
    summary: "Create a new admin user",
    request: {
        body: { content: { "application/json": { schema: createAdminSchema } } }
    },
    responses: {
        201: {
            description: "Admin user created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        message: z.string(),
                        user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
                        emailFailed: z.boolean().optional(),
                        onboardingRequired: z.boolean(),
                    }))
                }
            }
        },
        ...errorResponses,
    }
});

app.openapi(createUserRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const env = c.env;
        const auth = createAuth(env);

        const { name, email, roleId } = c.req.valid("json");

        if (!env.BETTER_AUTH_URL && !env.PUBLIC_API_BASE_URL) {
            throw new ValidationError("BETTER_AUTH_URL or PUBLIC_API_BASE_URL must be configured");
        }

        if (roleId) {
            const roleExists = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get();
            if (!roleExists) throw new ValidationError("Selected role does not exist");
        }

        const existingUser = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
        if (existingUser) throw new ConflictError("A user with this email already exists");

        const bootstrapPassword = generateBootstrapPassword();

        const signUpResult = await auth.api.signUpEmail({
            body: { name, email, password: bootstrapPassword }
        });

        if (!signUpResult || !signUpResult.user) {
            throw new ServiceUnavailableError("Could not create admin user");
        }

        await db
            .update(user)
            .set({
                role: "admin",
                emailVerified: true,
                mustChangePassword: true,
                mustEnrollTwoFactor: true,
            })
            .where(eq(user.id, signUpResult.user.id));

        if (roleId) {
            await assignRoleToUser(db, signUpResult.user.id, roleId, sessionUser.id, env.CACHE as KVNamespace | undefined);
        }

        let emailFailed = false;
        try {
            await auth.api.requestPasswordReset({
                headers: c.req.raw.headers,
                body: {
                    email,
                    redirectTo: "/auth/reset-password",
                },
            });
        } catch (emailError: unknown) {
            console.error("Failed to send admin setup email:", emailError);
            emailFailed = true;
        }

        if (emailFailed) {
            return created(c, {
                message: "Admin user created but the setup email failed to send. The account is blocked until the password reset flow is completed and 2FA is enabled.",
                user: { id: signUpResult.user.id, name, email },
                emailFailed: true,
                onboardingRequired: true,
            });
        }

        return created(c, {
            message: "Admin user created successfully. A secure setup link has been sent.",
            user: { id: signUpResult.user.id, name, email },
            onboardingRequired: true,
        });
    } catch (error: unknown) {
        console.error("Create admin user error:", error);
        throw error;
    }
});

const deleteUserRoute = createRoute({
    method: "delete",
    path: "/users/{id}",
    tags: ["Admin - Auth Management"],
    summary: "Delete an admin user",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "User deleted", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(deleteUserRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const { id: userId } = c.req.valid("param");

        if (userId === sessionUser.id) {
            throw new ValidationError("You cannot delete your own account");
        }

        const userToDelete = await db.select({ id: user.id, role: user.role, isSuperAdmin: user.isSuperAdmin }).from(user).where(eq(user.id, userId)).get();
        if (!userToDelete) throw new NotFoundError("User not found");
        if (userToDelete.isSuperAdmin) throw new ValidationError("Cannot delete a super admin user");

        const targetAdminPrincipal = await db
            .selectDistinct({ id: user.id })
            .from(user)
            .leftJoin(userRoles, eq(userRoles.userId, user.id))
            .leftJoin(userPermissions, and(
                eq(userPermissions.userId, user.id),
                eq(userPermissions.granted, true),
            ))
            .where(and(eq(user.id, userId), adminPrincipalPredicate()));
        if (targetAdminPrincipal.length === 0) throw new ValidationError("Can only delete admin users through this endpoint");

        const adminCount = await db
            .selectDistinct({ id: user.id })
            .from(user)
            .leftJoin(userRoles, eq(userRoles.userId, user.id))
            .leftJoin(userPermissions, and(
                eq(userPermissions.userId, user.id),
                eq(userPermissions.granted, true),
            ))
            .where(adminPrincipalPredicate());
        if (adminCount.length <= 1) throw new ValidationError("Cannot delete the last admin user");

        await db.delete(user).where(eq(user.id, userId));

        return ok(c, { message: "Admin user deleted successfully" });
    } catch (error: unknown) {
        console.error("Delete admin user error:", error);
        throw error;
    }
});

// ─────────────────────────────────────────
// Profile & Password
// ─────────────────────────────────────────

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12, "New password must be at least 12 characters")
});

const changePasswordRoute = createRoute({
    method: "post",
    path: "/change-password",
    tags: ["Admin - Auth Management"],
    summary: "Change current user password",
    request: {
        body: { content: { "application/json": { schema: changePasswordSchema } } }
    },
    responses: {
        200: { description: "Password changed", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(changePasswordRoute, async (c) => {
    try {
        const session = c.get("session");
        const sessionUser = c.get("user");
        const env = c.env;
        const auth = createAuth(env);
        const { currentPassword, newPassword } = c.req.valid("json");

        if (!session) {
            throw new UnauthorizedError("No active session found");
        }

        const result = await auth.api.changePassword({
            headers: c.req.raw.headers,
            body: { currentPassword, newPassword, revokeOtherSessions: true },
            returnHeaders: true,
        }) as BetterAuthHeadersResult<unknown>;

        appendBetterAuthSetCookies(c, result.headers);

        if (!result.response) throw new ValidationError("Unable to change password. Please check your current password.");

        const db = c.get("db");
        await db
            .update(user)
            .set({ mustChangePassword: false, updatedAt: new Date() })
            .where(eq(user.id, sessionUser.id));

        return ok(c, { message: "Password changed successfully" });
    } catch (error: unknown) {
        console.error("Change password error:", error);
        if (error instanceof Error && (error.message?.includes("password") || error.message?.includes("incorrect"))) {
            throw new ValidationError("Current password is incorrect");
        }
        throw error;
    }
});

const updateProfileSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters").optional(),
    image: z.string().url().optional().nullable()
});

const updateProfileRoute = createRoute({
    method: "post",
    path: "/update-profile",
    tags: ["Admin - Auth Management"],
    summary: "Update current user profile",
    request: {
        body: { content: { "application/json": { schema: updateProfileSchema } } }
    },
    responses: {
        200: { description: "Profile updated", content: { "application/json": { schema: successEnvelope(z.object({ user: z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() }).passthrough().nullable().optional() })) } } },
        ...errorResponses,
    }
});

app.openapi(updateProfileRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const { name, image } = c.req.valid("json");

        const updateData: { name?: string; image?: string | null; updatedAt: Date } = { updatedAt: new Date() };
        if (name !== undefined) updateData.name = name.trim();
        if (image !== undefined) updateData.image = image;

        await db.update(user).set(updateData).where(eq(user.id, sessionUser.id));

        const updatedUser = await db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image })
            .from(user)
            .where(eq(user.id, sessionUser.id))
            .get();

        return ok(c, { user: updatedUser });
    } catch (error: unknown) {
        console.error("Error updating profile:", error);
        throw error;
    }
});

// ─────────────────────────────────────────
// 2FA Management
// ─────────────────────────────────────────

const get2faInfoRoute = createRoute({
    method: "get",
    path: "/2fa/info",
    tags: ["Admin - Auth Management"],
    summary: "Get 2FA info for current user",
    responses: {
        200: { description: "2FA info", content: { "application/json": { schema: successEnvelope(z.object({ method: z.string(), twoFactorEnabled: z.boolean(), email: z.string() })) } } },
        ...errorResponses,
    }
});

app.openapi(get2faInfoRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");

    const userData = await db
        .select({ twoFactorMethod: user.twoFactorMethod, twoFactorEnabled: user.twoFactorEnabled, email: user.email })
        .from(user)
        .where(eq(user.id, sessionUser.id))
        .get();

    if (!userData) throw new NotFoundError("User not found");

    return ok(c, {
        method: userData.twoFactorMethod || "email",
        twoFactorEnabled: userData.twoFactorEnabled,
        email: userData.email
    });
});

const complete2faVerificationRoute = createRoute({
    method: "post",
    path: "/2fa/complete-verification",
    tags: ["Admin - Auth Management"],
    summary: "Complete 2FA verification for a proven session",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({ sessionToken: z.string().min(32) })
                }
            }
        }
    },
    responses: {
        200: { description: "2FA verification completed", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(complete2faVerificationRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const session = c.get("session");
    const { sessionToken } = c.req.valid("json");

    if (!session) {
        throw new UnauthorizedError("No active session found");
    }

    if (!sessionUser.twoFactorEnabled) {
        throw new ForbiddenError("Two-factor authentication is not enabled for this account");
    }

    const matchingSession = await db
        .select({ id: sessionTable.id })
        .from(sessionTable)
        .where(and(
            eq(sessionTable.id, session.id),
            eq(sessionTable.userId, sessionUser.id),
            eq(sessionTable.token, sessionToken),
        ))
        .get();

    if (!matchingSession) {
        throw new UnauthorizedError("Two-factor verification proof is invalid");
    }

    await db
        .update(sessionTable)
        .set({ twoFactorVerified: true })
        .where(eq(sessionTable.id, matchingSession.id));

    return ok(c, { message: "Two-factor authentication verified" });
});

const update2faMethodSchema = z.object({
    method: z.enum(["totp", "email"]),
    code: z.string().min(1).optional(),
    sessionToken: z.string().min(32).optional(),
}).refine((data) => Boolean(data.code) !== Boolean(data.sessionToken), {
    message: "Provide either a verification code or a session proof",
    path: ["code"],
});

const update2faMethodRoute = createRoute({
    method: "post",
    path: "/2fa/method",
    tags: ["Admin - Auth Management"],
    summary: "Update 2FA method",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: update2faMethodSchema,
                },
            },
        },
    },
    responses: {
        200: { description: "Method updated", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(update2faMethodRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const session = c.get("session");
    const { method, code, sessionToken: provenSessionToken } = c.req.valid("json");

    if (!session) {
        throw new UnauthorizedError("No active session found");
    }

    let verifiedSessionId = session.id;
    const sessionToken = provenSessionToken;
    if (sessionToken) {
        const sessionByToken = await db
            .select({ id: sessionTable.id })
            .from(sessionTable)
            .where(and(
                eq(sessionTable.id, session.id),
                eq(sessionTable.token, sessionToken),
                eq(sessionTable.userId, sessionUser.id),
            ))
            .get();
        if (!sessionByToken) {
            throw new UnauthorizedError("Two-factor method proof is invalid");
        }
        verifiedSessionId = sessionByToken.id;
    } else if (code) {
        const auth = createAuth(c.env);
        const verifiedProof = await (async () => {
            try {
                const betterAuthResult = method === "email"
                    ? await auth.api.verifyTwoFactorOTP({
                        headers: c.req.raw.headers,
                        body: { code, trustDevice: false },
                        returnHeaders: true,
                    }) as BetterAuthHeadersResult<{ token?: string }>
                    : await auth.api.verifyTOTP({
                        headers: c.req.raw.headers,
                        body: { code, trustDevice: false },
                        returnHeaders: true,
                    }) as BetterAuthHeadersResult<{ token?: string }>;
                appendBetterAuthSetCookies(c, betterAuthResult.headers);
                const cookieSessionToken = getSessionTokenFromSetCookie(betterAuthResult.headers, auth);
                return {
                    token: cookieSessionToken ?? betterAuthResult.response?.token,
                    allowRotatedCookieSession: Boolean(cookieSessionToken),
                };
            } catch {
                throw new ValidationError("The verification code is invalid or expired");
            }
        })();

        const verifiedToken = verifiedProof.token;
        if (verifiedToken) {
            const sessionByToken = await db
                .select({ id: sessionTable.id })
                .from(sessionTable)
                .where(
                    verifiedProof.allowRotatedCookieSession
                        ? and(
                            eq(sessionTable.token, verifiedToken),
                            eq(sessionTable.userId, sessionUser.id),
                        )
                        : and(
                            eq(sessionTable.id, session.id),
                            eq(sessionTable.token, verifiedToken),
                            eq(sessionTable.userId, sessionUser.id),
                        )
                )
                .get();
            if (!sessionByToken) {
                throw new UnauthorizedError("Two-factor method proof is invalid");
            }
            verifiedSessionId = sessionByToken.id;
        }
    }

    await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, verifiedSessionId));
    await db.update(user).set({
        twoFactorMethod: method,
        mustEnrollTwoFactor: false,
        updatedAt: new Date(),
    }).where(eq(user.id, sessionUser.id));

    return ok(c, {});
});

const verify2faRoute = createRoute({
    method: "post",
    path: "/2fa/verify",
    tags: ["Admin - Auth Management"],
    summary: "Verify 2FA code",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        code: z.string(),
                        trustDevice: z.boolean().optional(),
                        type: z.enum(["totp", "email", "backup"]).optional().default("totp")
                    })
                }
            }
        }
    },
    responses: {
        200: { description: "2FA verified", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(verify2faRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const session = c.get("session");
    const { code, trustDevice, type } = c.req.valid("json");

    if (!session) {
        throw new UnauthorizedError("No active session found");
    }

    if (trustDevice === true) {
        throw new ValidationError("Trusted-device 2FA verification is not enabled");
    }

    const auth = createAuth(c.env);
    const verifyResult = await (async () => {
        try {
            if (type === "backup") {
                return await auth.api.verifyBackupCode({ headers: c.req.raw.headers, body: { code } });
            }
            if (type === "email") {
                return await auth.api.verifyTwoFactorOTP({ headers: c.req.raw.headers, body: { code, trustDevice: trustDevice ?? false } });
            }
            return await auth.api.verifyTOTP({ headers: c.req.raw.headers, body: { code, trustDevice: trustDevice ?? false } });
        } catch {
            throw new ValidationError("The verification code is invalid or expired");
        }
    })() as { token?: string; user?: { id: string } } | null;

    const sessionToken = verifyResult?.token;
    if (sessionToken) {
        const sessionByToken = await db
            .select({ id: sessionTable.id })
            .from(sessionTable)
            .where(and(
                eq(sessionTable.id, session.id),
                eq(sessionTable.userId, sessionUser.id),
                eq(sessionTable.token, sessionToken),
            ))
            .get();
        if (!sessionByToken) {
            throw new UnauthorizedError("Two-factor verification proof is invalid");
        }

        await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, sessionByToken.id));
        return ok(c, { message: "Two-factor authentication verified" });
    }

    await db.update(sessionTable).set({ twoFactorVerified: true }).where(and(
        eq(sessionTable.id, session.id),
        eq(sessionTable.userId, sessionUser.id),
    ));
    return ok(c, { message: "Two-factor authentication verified" });
});

// ─────────────────────────────────────────
// Account Security
// ─────────────────────────────────────────

const getAccountSecurityRoute = createRoute({
    method: "get",
    path: "/account-security",
    tags: ["Admin - Auth Management"],
    summary: "Get current user account security data",
    responses: {
        200: { description: "Account security data", content: { "application/json": { schema: successEnvelope(z.object({ twoFactorMethod: z.string().nullable(), isSuperAdmin: z.boolean() })) } } },
        ...errorResponses,
    }
});

app.openapi(getAccountSecurityRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const dbUser = await db
        .select({
            twoFactorMethod: user.twoFactorMethod,
            isSuperAdmin: user.isSuperAdmin,
        })
        .from(user)
        .where(eq(user.id, sessionUser.id))
        .get();

    return ok(c, {
        twoFactorMethod: dbUser?.twoFactorMethod || null,
        isSuperAdmin: dbUser?.isSuperAdmin ?? false,
    });
});

// ─────────────────────────────────────────
// Setup Endpoint (bypasses normal auth)
// ─────────────────────────────────────────

const setupApp = new OpenAPIHono<{ Bindings: Env }>();

async function firstAdminExists(db: Database): Promise<boolean> {
    const row = await db
        .select({ found: sql<number>`1` })
        .from(user)
        .where(or(eq(user.role, "admin"), eq(user.isSuperAdmin, true)))
        .limit(1)
        .get();

    return row != null;
}

// ── Admin Exists Check (for setup page) ──

const adminExistsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Setup"],
    summary: "Check if any admin user exists",
    responses: {
        200: { description: "Admin exists status", content: { "application/json": { schema: successEnvelope(z.object({ adminExists: z.boolean() })) } } },
    }
});

setupApp.openapi(adminExistsRoute, async (c) => {
    const db = c.get("db");
    const adminExists = await firstAdminExists(db);
    return ok(c, { adminExists });
});

const setupSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(12, "Password must be at least 12 characters")
});

function isBetterAuthUserAlreadyExistsError(error: unknown): boolean {
    const candidate = error as {
        body?: { code?: string; message?: string };
        message?: string;
        statusCode?: number;
    };

    return (
        candidate?.body?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
        candidate?.body?.message === "User already exists. Use another email." ||
        candidate?.message === "User already exists. Use another email."
    );
}

async function verifyExistingSetupAccountPassword(
    auth: ReturnType<typeof createAuth>,
    db: Pick<Database, "delete">,
    email: string,
    password: string,
): Promise<boolean> {
    try {
        const result = await auth.api.signInEmail({ body: { email, password } });
        const token = (result as { token?: string } | undefined)?.token;
        if (!token) return false;
        await db.delete(sessionTable).where(eq(sessionTable.token, token));
        return true;
    } catch {
        return false;
    }
}

const setupRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Setup"],
    summary: "Initial admin setup (first user only)",
    request: {
        body: { content: { "application/json": { schema: setupSchema } } }
    },
    responses: {
        201: { description: "Admin account created", content: { "application/json": { schema: successEnvelope(z.object({ message: z.string(), userId: z.string() })) } } },
        ...errorResponses,
    }
});

setupApp.openapi(setupRoute, async (c) => {
    const db = c.get("db");
    const env = c.env as Env;

    // Check admin exists FIRST (before rate limiting) — this is the primary guard
    const adminExists = await firstAdminExists(db);

    if (adminExists) {
        const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
        console.warn(`[SECURITY] Setup endpoint accessed after admin exists. IP: ${ip}`);
        throw new ForbiddenError("An admin user already exists. Please use the login page.");
    }

    // D1 is the setup authority: KV is eventually consistent and cannot be a
    // compare-and-set lock for first-admin bootstrap.
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
    const kv = env.CACHE as KVNamespace | undefined;
    await enforceAdminSetupRateLimit(db, ip);

    const auth = createAuth(env);

    const { name, email, password } = c.req.valid("json");
    let setupClaim: ClaimedAdminSetup | null = null;
    let promotedUserId: string | null = null;

    try {
        setupClaim = await claimAdminSetup(db);

        const currentAdminExists = await firstAdminExists(db);
        if (currentAdminExists) {
            await markAdminSetupClaimCompleted(db, setupClaim, null);
            setupClaim = null;
            throw new ForbiddenError("An admin user already exists. Please use the login page.");
        }

        try {
            const signUpResult = await auth.api.signUpEmail({ body: { name, email, password } });
            if (!signUpResult || !signUpResult.user) {
                throw new ServiceUnavailableError("Could not create user account");
            }

            await completeAdminSetupClaimWithUserPromotion(db, setupClaim, {
                userId: signUpResult.user.id,
            });
            promotedUserId = signUpResult.user.id;
            setupClaim = null;

            const { autoSeedRbacIfNeeded } = await import("@scalius/core/auth/rbac/auto-seed");
            await autoSeedRbacIfNeeded(db, kv);

            return created(c, { message: "Admin account created successfully", userId: signUpResult.user.id });
        } catch (error: unknown) {
            if (!isBetterAuthUserAlreadyExistsError(error)) {
                throw error;
            }

            const existingUser = await db
                .select({ id: user.id })
                .from(user)
                .where(eq(user.email, email))
                .get();

            if (!existingUser) {
                throw error;
            }

            const currentAdminExists = await firstAdminExists(db);
            if (currentAdminExists) {
                throw new ForbiddenError("An admin user already exists. Please use the login page.");
            }

            const passwordMatchesExistingAccount = await verifyExistingSetupAccountPassword(
                auth,
                db,
                email,
                password,
            );
            if (!passwordMatchesExistingAccount) {
                throw new ConflictError(
                    "An account with this email already exists. Use that account's existing password or reset it before completing first-admin setup.",
                );
            }

            if (!setupClaim) {
                throw new ServiceUnavailableError("Admin setup claim is unavailable. Please retry setup.");
            }
            await completeAdminSetupClaimWithUserPromotion(db, setupClaim, {
                userId: existingUser.id,
                name,
            });
            promotedUserId = existingUser.id;
            setupClaim = null;

            const { autoSeedRbacIfNeeded } = await import("@scalius/core/auth/rbac/auto-seed");
            await autoSeedRbacIfNeeded(db, kv);

            return created(c, { message: "Admin account recovered successfully", userId: existingUser.id });
        }
    } catch (error) {
        if (setupClaim) {
            try {
                if (promotedUserId) {
                    await markAdminSetupClaimCompleted(db, setupClaim, promotedUserId);
                } else {
                    await markAdminSetupClaimFailed(db, setupClaim, error);
                }
            } catch (cleanupError) {
                console.warn("Failed to finalize setup claim:", cleanupError);
            }
        }
        throw error;
    }
});

export { app as adminAuthManagementRoutes, setupApp as authSetupRoutes };
