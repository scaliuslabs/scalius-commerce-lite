// src/server/routes/admin/auth-management.ts
// Admin OpenAPI routes for auth management (users, profile, 2FA, setup).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { getCookies, parseSetCookieHeader, splitSetCookieHeader } from "better-auth/cookies";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    adminInvitations,
    permissions,
    rolePermissions,
    roles,
    session as sessionTable,
    twoFactor as twoFactorTable,
    user,
    userPermissions,
    userRoles,
    verification,
} from "@scalius/database/schema";
import {
    adminPrincipalExists,
} from "@scalius/core/auth/admin-setup";
import {
    AUTH_PASSWORD_MAX_LENGTH,
    AUTH_PASSWORD_MIN_LENGTH,
    claimAdminSetup,
    completeAdminSetupClaimWithCredentialIdentity,
    completeAdminSetupClaimWithUserPromotion,
    createInvitedAdminCredentialAccount,
    createAuth,
    enforceAdminSetupRateLimit,
    isCredentialIdentityConflictError,
    markAdminSetupClaimCompleted,
    markAdminSetupClaimFailed,
    prepareCredentialIdentity,
    createPendingEmailMethodChallenge,
    createPendingTotpMethodChallenge,
    getTwoFactorMethodChallengeIdentifier,
    readPendingTwoFactorMethodChallenge,
    verifyPendingTotpCode,
    type ClaimedAdminSetup,
} from "@scalius/core/auth";
import { createScannerTokenClaim } from "@scalius/core/auth/scanner-token-claims";
import { SCANNER_TOKEN_TTL_SECONDS } from "@scalius/shared/scanner-auth";

import { ok, created } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError, NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "../../utils/api-error";
import {
    conflictResponse,
    errorResponses,
    messageResponse,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";
import {
    createAccountSessionCommandIdFactory,
    presentAccountSession,
} from "./account-session-presentation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const ADMIN_USER_ENRICHMENT_CHUNK_SIZE = 90;
const ADMIN_USER_PAGE_LIMIT = 2;
const ADMIN_USER_ROLE_LIMIT = 20;
const ADMIN_USER_OVERRIDE_LIMIT = 100;

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

function createOpaqueScannerToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `sct_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// ─────────────────────────────────────────
// Admin Users Management
// ─────────────────────────────────────────

const adminUserSchema = z.object({
    id: z.string().max(100),
    name: z.string().max(100),
    email: z.string().max(320),
    emailVerified: z.boolean(),
    image: z.string().max(2048).nullable(),
    twoFactorEnabled: z.boolean(),
    mustChangePassword: z.boolean(),
    mustEnrollTwoFactor: z.boolean(),
    suspended: z.boolean(),
    invitation: z.object({
        status: z.enum(["pending", "expired", "delivery_failed"]),
        expiresAt: z.string().nullable(),
        lastSentAt: z.string().nullable(),
    }).nullable(),
    isSuperAdmin: z.boolean(),
    createdAt: z.union([z.string(), z.number()]),
    roles: z.array(z.object({
        id: z.string().max(100),
        name: z.string().max(50),
        displayName: z.string().max(100),
    })).max(ADMIN_USER_ROLE_LIMIT),
    rolesTruncated: z.boolean(),
    overrides: z.object({
        grants: z.array(z.string().max(150)).max(ADMIN_USER_OVERRIDE_LIMIT),
        denials: z.array(z.string().max(150)).max(ADMIN_USER_OVERRIDE_LIMIT),
    }),
    overridesTruncated: z.boolean(),
});

const listUsersRoute = createRoute({
    method: "get",
    path: "/users",
    operationId: "dashboard.team.users.list",
    tags: ["Admin - Auth Management"],
    summary: "List all admin users",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(ADMIN_USER_PAGE_LIMIT).default(ADMIN_USER_PAGE_LIMIT),
        }),
    },
    responses: {
        200: { description: "Admin user list", content: { "application/json": { schema: successEnvelope(z.object({
            users: z.array(adminUserSchema),
            pagination: z.object({
                page: z.number().int().min(1),
                limit: z.number().int().min(1).max(ADMIN_USER_PAGE_LIMIT),
                hasMore: z.boolean(),
            }),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(listUsersRoute, async (c) => {
    try {
        const db = c.get("db");
        const { page, limit } = c.req.valid("query");

        const adminUserRows = await db
            .selectDistinct({
                id: user.id,
                name: user.name,
                email: user.email,
                emailVerified: user.emailVerified,
                image: user.image,
                twoFactorEnabled: user.twoFactorEnabled,
                mustChangePassword: user.mustChangePassword,
                mustEnrollTwoFactor: user.mustEnrollTwoFactor,
                banned: user.banned,
                banExpires: user.banExpires,
                invitationId: adminInvitations.id,
                invitationStatus: adminInvitations.status,
                invitationDeliveryStatus: adminInvitations.deliveryStatus,
                invitationExpiresAt: adminInvitations.expiresAt,
                invitationLastSentAt: adminInvitations.lastSentAt,
                isSuperAdmin: user.isSuperAdmin,
                createdAt: user.createdAt
            })
            .from(user)
            .leftJoin(userRoles, eq(userRoles.userId, user.id))
            .leftJoin(userPermissions, and(
                eq(userPermissions.userId, user.id),
                eq(userPermissions.granted, true),
            ))
            .leftJoin(adminInvitations, eq(adminInvitations.userId, user.id))
            .where(adminPrincipalPredicate())
            .orderBy(desc(user.createdAt), desc(user.id))
            .limit(limit + 1)
            .offset((page - 1) * limit);
        const hasMore = adminUserRows.length > limit;
        const adminUsers = adminUserRows.slice(0, limit);

        const rolesByUserId = new Map<string, Array<{
            id: string;
            name: string;
            displayName: string;
        }>>();
        const overridesByUserId = new Map<string, Array<{
            permissionName: string;
            granted: boolean;
        }>>();
        const adminUserIds = adminUsers.map(({ id }) => id);
        for (
            let offset = 0;
            offset < adminUserIds.length;
            offset += ADMIN_USER_ENRICHMENT_CHUNK_SIZE
        ) {
            const userIds = adminUserIds.slice(
                offset,
                offset + ADMIN_USER_ENRICHMENT_CHUNK_SIZE,
            );
            const [roleRows = [], overrideRows = []] = await safeBatch(db, [
                db
                    .select({
                        userId: userRoles.userId,
                        id: roles.id,
                        name: roles.name,
                        displayName: roles.displayName
                    })
                    .from(userRoles)
                    .innerJoin(roles, eq(userRoles.roleId, roles.id))
                    .where(inArray(userRoles.userId, userIds)),
                db
                    .select({
                        userId: userPermissions.userId,
                        permissionName: permissions.name,
                        granted: userPermissions.granted
                    })
                    .from(userPermissions)
                    .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
                    .where(inArray(userPermissions.userId, userIds)),
            ] as const);

            for (const row of roleRows) {
                const existing = rolesByUserId.get(row.userId) ?? [];
                existing.push({
                    id: row.id,
                    name: row.name,
                    displayName: row.displayName,
                });
                rolesByUserId.set(row.userId, existing);
            }
            for (const row of overrideRows) {
                const existing = overridesByUserId.get(row.userId) ?? [];
                existing.push({
                    permissionName: row.permissionName,
                    granted: row.granted,
                });
                overridesByUserId.set(row.userId, existing);
            }
        }

        const nowMs = Date.now();
        const usersWithRoles = adminUsers.map((adminUser) => {
            const allUserRoles = rolesByUserId.get(adminUser.id) ?? [];
            const userRoleData = allUserRoles.slice(0, ADMIN_USER_ROLE_LIMIT).map((role) => ({
                id: role.id.slice(0, 100),
                name: role.name.slice(0, 50),
                displayName: role.displayName.slice(0, 100),
            }));
            const allOverrides = overridesByUserId.get(adminUser.id) ?? [];
            const overrides = allOverrides.slice(0, ADMIN_USER_OVERRIDE_LIMIT);

            const grants = overrides.filter((o) => o.granted).map((o) => o.permissionName);
            const denials = overrides.filter((o) => !o.granted).map((o) => o.permissionName);

            const {
                banned,
                banExpires,
                invitationId,
                invitationStatus,
                invitationDeliveryStatus,
                invitationExpiresAt,
                invitationLastSentAt,
                ...publicAdminUser
            } = adminUser;
            const banExpiresAt = banExpires instanceof Date
                ? banExpires.getTime()
                : Number(banExpires ?? 0) * 1000;
            const pendingInvitation = invitationId
                && invitationStatus === "pending"
                && publicAdminUser.mustChangePassword;
            const invitationExpiryMs = invitationExpiresAt instanceof Date
                ? invitationExpiresAt.getTime()
                : Number(invitationExpiresAt ?? 0) * 1000;
            const invitation = pendingInvitation
                ? {
                    status: invitationDeliveryStatus === "failed"
                        ? "delivery_failed" as const
                        : invitationExpiresAt && invitationExpiryMs <= nowMs
                            ? "expired" as const
                            : "pending" as const,
                    expiresAt: invitationExpiresAt
                        ? new Date(invitationExpiryMs).toISOString()
                        : null,
                    lastSentAt: invitationLastSentAt
                        ? new Date(
                            invitationLastSentAt instanceof Date
                                ? invitationLastSentAt.getTime()
                                : Number(invitationLastSentAt) * 1000,
                        ).toISOString()
                        : null,
                }
                : null;

            return {
                ...publicAdminUser,
                id: publicAdminUser.id.slice(0, 100),
                name: publicAdminUser.name.slice(0, 100),
                email: publicAdminUser.email.slice(0, 320),
                image: publicAdminUser.image?.slice(0, 2048) ?? null,
                suspended: Boolean(banned && (!banExpires || banExpiresAt > nowMs)),
                invitation,
                roles: userRoleData,
                rolesTruncated: allUserRoles.length > userRoleData.length,
                overrides: {
                    grants: grants.map((name) => name.slice(0, 150)),
                    denials: denials.map((name) => name.slice(0, 150)),
                },
                overridesTruncated: allOverrides.length > overrides.length,
            };
        });

        return ok(c, {
            users: usersWithRoles,
            pagination: { page, limit, hasMore },
        });
    } catch (error: unknown) {
        console.error("Get admin users error:", error);
        throw error;
    }
});

const createAdminSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email().max(320),
    roleId: z.string().max(100).optional()
});

const createUserRoute = createRoute({
    method: "post",
    path: "/users",
    operationId: "dashboard.team.users.invite",
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
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(createUserRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const env = c.env;
        const auth = createAuth(env);

        const { name, email, roleId } = c.req.valid("json");
        const normalizedEmail = email.trim().toLowerCase();

        if (!env.BETTER_AUTH_URL && !env.PUBLIC_API_BASE_URL) {
            throw new ValidationError("BETTER_AUTH_URL or PUBLIC_API_BASE_URL must be configured");
        }

        if (roleId) {
            const selectedRole = await db
                .select({ id: roles.id, name: roles.name })
                .from(roles)
                .where(eq(roles.id, roleId))
                .get();
            if (!selectedRole) throw new ValidationError("Selected role does not exist");

            if (selectedRole.name === "super_admin" && sessionUser.isSuperAdmin !== true) {
                throw new ForbiddenError("Only the store owner can assign the Super Admin role");
            }

            const callerPermissions = c.get("adminPermissions");
            if (sessionUser.isSuperAdmin !== true) {
                const selectedRolePermissions = await db
                    .select({ name: permissions.name })
                    .from(rolePermissions)
                    .innerJoin(
                        permissions,
                        eq(rolePermissions.permissionId, permissions.id),
                    )
                    .where(eq(rolePermissions.roleId, roleId));
                const exceedsCallerAuthority = selectedRolePermissions.some(
                    ({ name: permissionName }) => !callerPermissions.has(permissionName),
                );
                if (exceedsCallerAuthority) {
                    throw new ForbiddenError(
                        "You cannot assign a role with permissions you do not have",
                    );
                }
            }
        }

        const existingUser = await db
            .select({ id: user.id })
            .from(user)
            .where(eq(user.email, normalizedEmail))
            .get();
        if (existingUser) throw new ConflictError("A user with this email already exists");

        const bootstrapPassword = generateBootstrapPassword();
        const credential = await prepareCredentialIdentity({
            name,
            email: normalizedEmail,
            password: bootstrapPassword,
        });
        const createdAdmin = await createInvitedAdminCredentialAccount(
            db,
            credential,
            {
                invitedByUserId: sessionUser.id,
                roleId,
            },
        );

        let emailFailed = false;
        try {
            await auth.api.requestPasswordReset({
                headers: c.req.raw.headers,
                body: {
                    email: createdAdmin.email,
                    redirectTo: "/auth/reset-password",
                },
            });
        } catch {
            console.warn("[Auth management] Administrator setup email delivery failed");
            emailFailed = true;
            await db
                .update(adminInvitations)
                .set({
                    deliveryStatus: "failed",
                    expiresAt: null,
                    updatedAt: new Date(),
                })
                .where(eq(adminInvitations.id, createdAdmin.invitationId));
        }

        if (emailFailed) {
            return created(c, {
                message: "Admin user created but the setup email failed to send. The account is blocked until the password reset flow is completed and 2FA is enabled.",
                user: { id: createdAdmin.userId, name: credential.name, email: createdAdmin.email },
                emailFailed: true,
                onboardingRequired: true,
            });
        }

        return created(c, {
            message: "Admin user created successfully. A secure setup link has been sent.",
            user: { id: createdAdmin.userId, name: credential.name, email: createdAdmin.email },
            onboardingRequired: true,
        });
    } catch (error: unknown) {
        console.error("Create admin user error:", error);
        throw error;
    }
});

const resendAdminSetupRoute = createRoute({
    method: "post",
    path: "/users/{id}/resend-setup",
    operationId: "dashboard.team.users.resend_invitation",
    tags: ["Admin - Auth Management"],
    summary: "Resend an invited administrator's password setup link",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Setup link sent", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(resendAdminSetupRoute, async (c) => {
    const db = c.get("db");
    const { id: userId } = c.req.valid("param");
    const env = c.env;

    if (!env.BETTER_AUTH_URL && !env.PUBLIC_API_BASE_URL) {
        throw new ValidationError("BETTER_AUTH_URL or PUBLIC_API_BASE_URL must be configured");
    }

    const invitedUser = await db
        .select({
            id: user.id,
            email: user.email,
            mustChangePassword: user.mustChangePassword,
            invitationId: adminInvitations.id,
            invitationStatus: adminInvitations.status,
        })
        .from(user)
        .leftJoin(adminInvitations, eq(adminInvitations.userId, user.id))
        .where(eq(user.id, userId))
        .get();

    if (!invitedUser) throw new NotFoundError("Administrator not found");

    const targetAdminPrincipal = await db
        .selectDistinct({ id: user.id })
        .from(user)
        .leftJoin(userRoles, eq(userRoles.userId, user.id))
        .leftJoin(userPermissions, and(
            eq(userPermissions.userId, user.id),
            eq(userPermissions.granted, true),
        ))
        .where(and(eq(user.id, userId), adminPrincipalPredicate()));

    if (targetAdminPrincipal.length === 0) {
        throw new ValidationError("Can only resend setup for administrator accounts");
    }
    if (!invitedUser.mustChangePassword) {
        throw new ValidationError("Password setup is already complete");
    }
    if (!invitedUser.invitationId || invitedUser.invitationStatus !== "pending") {
        throw new ValidationError("This administrator does not have a pending invitation");
    }

    const auth = createAuth(env);
    try {
        await auth.api.requestPasswordReset({
            headers: c.req.raw.headers,
            body: {
                email: invitedUser.email,
                redirectTo: "/auth/reset-password",
            },
        });
    } catch {
        await db
            .update(adminInvitations)
            .set({
                deliveryStatus: "failed",
                expiresAt: null,
                updatedAt: new Date(),
            })
            .where(eq(adminInvitations.id, invitedUser.invitationId));
        throw new ServiceUnavailableError("The setup email could not be sent. Check email delivery and try again.");
    }

    return ok(c, { message: "A new secure setup link was sent" });
});

const deleteUserRoute = createRoute({
    method: "delete",
    path: "/users/{id}",
    operationId: "dashboard.team.users.revoke_invitation",
    tags: ["Admin - Auth Management"],
    summary: "Revoke an unfinished administrator invitation",
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

        const userToDelete = await db.select({
            id: user.id,
            role: user.role,
            isSuperAdmin: user.isSuperAdmin,
            mustChangePassword: user.mustChangePassword,
            invitationId: adminInvitations.id,
            invitationStatus: adminInvitations.status,
        }).from(user)
            .leftJoin(adminInvitations, eq(adminInvitations.userId, user.id))
            .where(eq(user.id, userId)).get();
        if (!userToDelete) throw new NotFoundError("User not found");
        if (userToDelete.isSuperAdmin) throw new ValidationError("Cannot delete a super admin user");
        if (!userToDelete.mustChangePassword) {
            throw new ValidationError("Completed administrator access must be suspended instead of deleted");
        }
        if (!userToDelete.invitationId || userToDelete.invitationStatus !== "pending") {
            throw new ValidationError("Only a pending administrator invitation can be revoked");
        }

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

        const revokedAt = new Date();
        await safeBatch(db, [
            db.update(adminInvitations)
                .set({
                    status: "revoked",
                    userId: null,
                    revokedAt,
                    updatedAt: revokedAt,
                })
                .where(and(
                    eq(adminInvitations.id, userToDelete.invitationId),
                    eq(adminInvitations.status, "pending"),
                )),
            db.delete(user).where(eq(user.id, userId)),
        ]);

        return ok(c, { message: "Administrator invitation revoked" });
    } catch (error: unknown) {
        console.error("Delete admin user error:", error);
        throw error;
    }
});

const setAdminSuspensionRoute = createRoute({
    method: "post",
    path: "/users/{id}/suspension",
    operationId: "dashboard.team.users.set_suspension",
    tags: ["Admin - Auth Management"],
    summary: "Suspend or reactivate an administrator",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({ suspended: z.boolean() }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Administrator suspension updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        message: z.string(),
                        suspended: z.boolean(),
                    })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(setAdminSuspensionRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const { id: userId } = c.req.valid("param");
    const { suspended } = c.req.valid("json");

    if (userId === sessionUser.id) {
        throw new ValidationError("You cannot suspend your own account");
    }

    const target = await db
        .select({
            id: user.id,
            isSuperAdmin: user.isSuperAdmin,
            banned: user.banned,
        })
        .from(user)
        .where(eq(user.id, userId))
        .get();
    if (!target) throw new NotFoundError("Administrator not found");
    if (target.isSuperAdmin) {
        throw new ValidationError("The store owner cannot be suspended");
    }

    const targetAdminPrincipal = await db
        .selectDistinct({ id: user.id })
        .from(user)
        .leftJoin(userRoles, eq(userRoles.userId, user.id))
        .leftJoin(userPermissions, and(
            eq(userPermissions.userId, user.id),
            eq(userPermissions.granted, true),
        ))
        .where(and(eq(user.id, userId), adminPrincipalPredicate()));
    if (targetAdminPrincipal.length === 0) {
        throw new ValidationError("Can only change access for administrator accounts");
    }

    if (target.banned === suspended) {
        return ok(c, {
            message: suspended ? "Administrator is already suspended" : "Administrator is already active",
            suspended,
        });
    }

    const changedAt = new Date();
    if (!suspended) {
        await db
            .update(user)
            .set({
                banned: false,
                banReason: null,
                banExpires: null,
                updatedAt: changedAt,
            })
            .where(and(eq(user.id, userId), eq(user.banned, true)));

        return ok(c, {
            message: "Administrator access restored",
            suspended: false,
        });
    }

    const otherActiveAdmins = await db
        .selectDistinct({ id: user.id })
        .from(user)
        .leftJoin(userRoles, eq(userRoles.userId, user.id))
        .leftJoin(userPermissions, and(
            eq(userPermissions.userId, user.id),
            eq(userPermissions.granted, true),
        ))
        .where(and(
            ne(user.id, userId),
            eq(user.banned, false),
            eq(user.mustChangePassword, false),
            or(
                eq(user.mustEnrollTwoFactor, false),
                eq(user.twoFactorEnabled, true),
            ),
            adminPrincipalPredicate(),
        ));
    if (otherActiveAdmins.length === 0) {
        throw new ValidationError("Cannot suspend the last active administrator");
    }

    const authorityGuard = buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${user}
        WHERE ${user.id} = ${userId}
          AND ${user.isSuperAdmin} = ${false}
          AND ${user.banned} = ${false}
    ) AND EXISTS (
        SELECT 1 FROM ${user} AS other_admin
        LEFT JOIN ${userRoles} AS other_user_roles
          ON other_user_roles.user_id = other_admin.id
        LEFT JOIN ${userPermissions} AS other_user_permissions
          ON other_user_permissions.user_id = other_admin.id
         AND other_user_permissions.granted = ${true}
        WHERE other_admin.id <> ${userId}
          AND other_admin.banned = ${false}
          AND other_admin.must_change_password = ${false}
          AND (
            other_admin.must_enroll_two_factor = ${false}
            OR other_admin.two_factor_enabled = ${true}
          )
          AND (
            other_admin.role = 'admin'
            OR other_admin.is_super_admin = ${true}
            OR other_user_roles.id IS NOT NULL
            OR other_user_permissions.id IS NOT NULL
          )
    )`, "ADMIN_SUSPENSION_CONFLICT");

    try {
        await safeBatch(db, [
            authorityGuard,
            db.update(user)
                .set({
                    banned: true,
                    banReason: "Store access suspended by an administrator",
                    banExpires: null,
                    updatedAt: changedAt,
                })
                .where(and(eq(user.id, userId), eq(user.banned, false))),
            db.delete(sessionTable).where(eq(sessionTable.userId, userId)),
        ]);
    } catch (error) {
        if (isBatchGuardError(error, "ADMIN_SUSPENSION_CONFLICT")) {
            throw new ConflictError("Administrator access changed. Refresh the team list and try again");
        }
        throw error;
    }

    return ok(c, {
        message: "Administrator suspended and signed out",
        suspended: true,
    });
});

// ─────────────────────────────────────────
// Profile & Password
// ─────────────────────────────────────────

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH),
    newPassword: z.string()
        .min(AUTH_PASSWORD_MIN_LENGTH, `New password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters`)
        .max(AUTH_PASSWORD_MAX_LENGTH, `New password must be at most ${AUTH_PASSWORD_MAX_LENGTH} characters`)
});

const changePasswordRoute = createRoute({
    method: "post",
    path: "/change-password",
    operationId: "dashboard.account.password_change",
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
    name: z.string().min(2, "Name must be at least 2 characters").max(100).optional(),
    image: z.string().url().max(2048).refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
    }, "Profile image must use HTTP or HTTPS").optional().nullable()
});

const updateProfileRoute = createRoute({
    method: "post",
    path: "/update-profile",
    operationId: "dashboard.account.profile_update",
    tags: ["Admin - Auth Management"],
    summary: "Update current user profile",
    request: {
        body: { content: { "application/json": { schema: updateProfileSchema } } }
    },
    responses: {
        200: { description: "Profile updated", content: { "application/json": { schema: successEnvelope(z.object({ user: z.object({
            id: z.string().max(100),
            name: z.string().max(100),
            email: z.string().max(320),
            image: z.string().max(2048).nullable(),
        }).nullable().optional() })) } } },
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

        return ok(c, {
            user: updatedUser
                ? {
                    id: updatedUser.id.slice(0, 100),
                    name: updatedUser.name.slice(0, 100),
                    email: updatedUser.email.slice(0, 320),
                    image: updatedUser.image?.slice(0, 2048) ?? null,
                }
                : null,
        });
    } catch (error: unknown) {
        console.error("Error updating profile:", error);
        throw error;
    }
});

const createScannerLinkRoute = createRoute({
    method: "post",
    path: "/scanner-link",
    operationId: "dashboard.scanner_device.create_link",
    tags: ["Admin - Auth Management"],
    summary: "Create a one-time scanner device pairing token",
    responses: {
        201: {
            description: "One-time scanner pairing token created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        token: z.string().regex(/^sct_[a-f0-9]{64}$/),
                        expiresAt: z.string().datetime(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(createScannerLinkRoute, async (c) => {
    const db = c.get("db");
    const principal = c.get("user");
    const owner = await db
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, principal.id))
        .get();
    if (!owner) throw new NotFoundError("Administrator not found");

    const token = createOpaqueScannerToken();
    const nowMs = Date.now();
    await createScannerTokenClaim(db, {
        token,
        adminId: principal.id,
        adminName: owner.name || owner.email,
        nowMs,
    });

    c.header("Cache-Control", "private, no-store, max-age=0");
    return created(c, {
        token,
        expiresAt: new Date(nowMs + SCANNER_TOKEN_TTL_SECONDS * 1_000).toISOString(),
    });
});

// ─────────────────────────────────────────
// 2FA Management
// ─────────────────────────────────────────

const get2faInfoRoute = createRoute({
    method: "get",
    path: "/2fa/info",
    operationId: "dashboard.account.two_factor.get",
    tags: ["Admin - Auth Management"],
    summary: "Get 2FA info for current user",
    responses: {
        200: { description: "2FA info", content: { "application/json": { schema: successEnvelope(z.object({ method: z.string().max(20), twoFactorEnabled: z.boolean(), email: z.string().max(320) })) } } },
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
        method: (userData.twoFactorMethod || "email").slice(0, 20),
        twoFactorEnabled: userData.twoFactorEnabled,
        email: userData.email.slice(0, 320)
    });
});

const start2faMethodChallengeRoute = createRoute({
    method: "post",
    path: "/2fa/method-challenge",
    operationId: "dashboard.account.two_factor.method_challenge",
    tags: ["Admin - Auth Management"],
    summary: "Start a staged two-factor method change",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        method: z.enum(["totp", "email"]),
                        password: z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Staged method challenge created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        challengeId: z.string().max(100),
                        totpUri: z.string().max(4096).nullable(),
                        expiresAt: z.string().datetime(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(start2faMethodChallengeRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const session = c.get("session");
    const { method, password } = c.req.valid("json");

    if (!session) {
        throw new UnauthorizedError("No active session found");
    }
    if (!sessionUser.twoFactorEnabled) {
        throw new ConflictError("Two-factor setup must be completed before changing its method");
    }

    const authSecret = c.env.BETTER_AUTH_SECRET?.trim();
    if (!authSecret) {
        throw new ServiceUnavailableError("Two-factor method changes are unavailable");
    }

    const auth = createAuth(c.env);
    const passwordProof = await (async () => {
        try {
            return await auth.api.verifyPassword({
                headers: c.req.raw.headers,
                body: { password },
            });
        } catch {
            throw new ValidationError("Password confirmation failed");
        }
    })();
    if (passwordProof.status !== true) {
        throw new ValidationError("Password confirmation failed");
    }

    const staged = method === "totp"
        ? await createPendingTotpMethodChallenge({
            authSecret,
            userId: sessionUser.id,
            sessionId: session.id,
            email: sessionUser.email,
        })
        : await createPendingEmailMethodChallenge({
            authSecret,
            userId: sessionUser.id,
            sessionId: session.id,
        });
    const now = new Date();
    await db.batch([
        db.delete(verification).where(
            eq(verification.identifier, staged.identifier),
        ),
        db.insert(verification).values({
            id: staged.challengeId,
            identifier: staged.identifier,
            value: staged.encryptedValue,
            expiresAt: staged.expiresAt,
            createdAt: now,
            updatedAt: now,
        }),
    ]);

    const totpUri = "totpUri" in staged && typeof staged.totpUri === "string"
        ? staged.totpUri
        : null;
    return ok(c, {
        challengeId: staged.challengeId,
        totpUri,
        expiresAt: staged.expiresAt.toISOString(),
    });
});

const update2faMethodSchema = z.union([
    z.object({
        method: z.literal("totp"),
        challengeId: z.string().regex(/^tfmc_[a-f0-9]{32}$/),
        code: z.string().regex(/^\d{6}$/),
    }),
    z.object({
        method: z.literal("email"),
        challengeId: z.string().regex(/^tfmc_[a-f0-9]{32}$/),
        code: z.string().regex(/^\d{6}$/),
    }),
    z.object({
        method: z.enum(["totp", "email"]),
        code: z.string().regex(/^\d{6}$/),
    }),
]);

const update2faMethodRoute = createRoute({
    method: "post",
    path: "/2fa/method",
    operationId: "dashboard.account.two_factor.method_update",
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
        200: {
            description: "Method updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        backupCodes: z.array(z.string().max(100)).max(20).optional(),
                    })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(update2faMethodRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const session = c.get("session");
    const methodInput = c.req.valid("json");
    const { method } = methodInput;

    if (!session) {
        throw new UnauthorizedError("No active session found");
    }

    const verifySubmittedCode = async (
        verificationMethod: "totp" | "email",
        code: string,
    ): Promise<{ sessionId: string; sessionToken: string }> => {
        const auth = createAuth(c.env);
        const verifiedProof = await (async () => {
            try {
                const betterAuthResult = verificationMethod === "email"
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
                const cookieSessionToken = getSessionTokenFromSetCookie(
                    betterAuthResult.headers,
                    auth,
                );
                return {
                    token: cookieSessionToken ?? betterAuthResult.response?.token,
                    allowRotatedCookieSession: Boolean(cookieSessionToken),
                };
            } catch {
                throw new ValidationError("The verification code is invalid or expired");
            }
        })();

        if (!verifiedProof.token) {
            throw new UnauthorizedError("Two-factor verification did not return a session proof");
        }
        const verifiedSession = await db
            .select({ id: sessionTable.id, token: sessionTable.token })
            .from(sessionTable)
            .where(
                verifiedProof.allowRotatedCookieSession
                    ? and(
                        eq(sessionTable.token, verifiedProof.token),
                        eq(sessionTable.userId, sessionUser.id),
                    )
                    : and(
                        eq(sessionTable.id, session.id),
                        eq(sessionTable.token, verifiedProof.token),
                        eq(sessionTable.userId, sessionUser.id),
                    ),
            )
            .get();
        if (!verifiedSession) {
            throw new UnauthorizedError("Two-factor method proof is invalid");
        }
        return {
            sessionId: verifiedSession.id,
            sessionToken: verifiedSession.token,
        };
    };

    if ("challengeId" in methodInput) {
        if (!sessionUser.twoFactorEnabled) {
            throw new ConflictError("Two-factor setup must be completed before changing its method");
        }

        const authSecret = c.env.BETTER_AUTH_SECRET?.trim();
        if (!authSecret) {
            throw new ServiceUnavailableError("Two-factor method changes are unavailable");
        }

        const now = new Date();
        const identifier = getTwoFactorMethodChallengeIdentifier(
            sessionUser.id,
            session.id,
        );
        const challengeRow = await db
            .select({ value: verification.value })
            .from(verification)
            .where(and(
                eq(verification.id, methodInput.challengeId),
                eq(verification.identifier, identifier),
                gt(verification.expiresAt, now),
            ))
            .get();
        if (!challengeRow) {
            throw new ValidationError("The authenticator setup expired or was already used");
        }

        const pending = await readPendingTwoFactorMethodChallenge({
            authSecret,
            encryptedValue: challengeRow.value,
            userId: sessionUser.id,
            sessionId: session.id,
            expectedMethod: method,
            now,
        });
        if (!pending) {
            throw new ValidationError("The verification method change expired or is invalid");
        }

        const existingTwoFactorRows = await db
            .select({ id: twoFactorTable.id })
            .from(twoFactorTable)
            .where(eq(twoFactorTable.userId, sessionUser.id))
            .limit(2);
        if (existingTwoFactorRows.length !== 1) {
            throw new ConflictError("The existing two-factor authority is unavailable");
        }
        const existingTwoFactor = existingTwoFactorRows[0]!;

        if (pending.method === "email") {
            const proofSession = await verifySubmittedCode("email", methodInput.code);

            const claimedAt = new Date();
            const emailGuard = buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${verification}
                WHERE ${verification.id} = ${methodInput.challengeId}
                  AND ${verification.identifier} = ${identifier}
                  AND ${verification.expiresAt} > ${now}
            ) AND EXISTS (
                SELECT 1 FROM ${user}
                WHERE ${user.id} = ${sessionUser.id}
                  AND ${user.twoFactorEnabled} = ${true}
            ) AND EXISTS (
                SELECT 1 FROM ${sessionTable}
                WHERE ${sessionTable.id} = ${proofSession.sessionId}
                  AND ${sessionTable.userId} = ${sessionUser.id}
                  AND ${sessionTable.token} = ${proofSession.sessionToken}
            ) AND EXISTS (
                SELECT 1 FROM ${twoFactorTable}
                WHERE ${twoFactorTable.id} = ${existingTwoFactor.id}
                  AND ${twoFactorTable.userId} = ${sessionUser.id}
            )`, "TWO_FACTOR_METHOD_CHALLENGE_CONFLICT");
            try {
                await safeBatch(db, [
                    emailGuard,
                    db.update(user)
                        .set({
                            twoFactorEnabled: true,
                            twoFactorMethod: "email",
                            mustEnrollTwoFactor: false,
                            updatedAt: claimedAt,
                        })
                        .where(eq(user.id, sessionUser.id)),
                    db.update(sessionTable)
                        .set({ twoFactorVerified: true, updatedAt: claimedAt })
                        .where(and(
                            eq(sessionTable.id, proofSession.sessionId),
                            eq(sessionTable.userId, sessionUser.id),
                            eq(sessionTable.token, proofSession.sessionToken),
                        )),
                    db.delete(verification).where(and(
                        eq(verification.id, methodInput.challengeId),
                        eq(verification.identifier, identifier),
                    )),
                ]);
            } catch (error) {
                if (isBatchGuardError(error, "TWO_FACTOR_METHOD_CHALLENGE_CONFLICT")) {
                    throw new ConflictError("The email method change was already used or became stale");
                }
                throw error;
            }

            return ok(c, {});
        }

        if (!("code" in methodInput) || !(await verifyPendingTotpCode(
            pending.secret,
            methodInput.code,
        ))) {
            throw new ValidationError("The verification code is invalid or expired");
        }

        const authorityGuard = buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${verification}
            WHERE ${verification.id} = ${methodInput.challengeId}
              AND ${verification.identifier} = ${identifier}
              AND ${verification.expiresAt} > ${now}
        ) AND EXISTS (
            SELECT 1 FROM ${user}
            WHERE ${user.id} = ${sessionUser.id}
              AND ${user.twoFactorEnabled} = ${true}
        ) AND EXISTS (
            SELECT 1 FROM ${sessionTable}
            WHERE ${sessionTable.id} = ${session.id}
              AND ${sessionTable.userId} = ${sessionUser.id}
        ) AND EXISTS (
            SELECT 1 FROM ${twoFactorTable}
            WHERE ${twoFactorTable.id} = ${existingTwoFactor.id}
              AND ${twoFactorTable.userId} = ${sessionUser.id}
        )`, "TWO_FACTOR_METHOD_CHALLENGE_CONFLICT");
        const claimedAt = new Date();
        try {
            await safeBatch(db, [
                authorityGuard,
                db.update(twoFactorTable)
                    .set({
                        secret: pending.encryptedSecret,
                        backupCodes: pending.storedBackupCodes,
                        verified: true,
                        updatedAt: claimedAt,
                    })
                    .where(and(
                        eq(twoFactorTable.id, existingTwoFactor.id),
                        eq(twoFactorTable.userId, sessionUser.id),
                    )),
                db.update(user)
                    .set({
                        twoFactorEnabled: true,
                        twoFactorMethod: "totp",
                        mustEnrollTwoFactor: false,
                        updatedAt: claimedAt,
                    })
                    .where(eq(user.id, sessionUser.id)),
                db.update(sessionTable)
                    .set({ twoFactorVerified: true, updatedAt: claimedAt })
                    .where(and(
                        eq(sessionTable.id, session.id),
                        eq(sessionTable.userId, sessionUser.id),
                    )),
                db.delete(verification).where(and(
                    eq(verification.id, methodInput.challengeId),
                    eq(verification.identifier, identifier),
                )),
            ]);
        } catch (error) {
            if (isBatchGuardError(error, "TWO_FACTOR_METHOD_CHALLENGE_CONFLICT")) {
                throw new ConflictError("The authenticator setup changed before it could be committed");
            }
            throw error;
        }

        return ok(c, { backupCodes: pending.backupCodes });
    }

    const currentMethod = sessionUser.twoFactorMethod === "totp" ||
        sessionUser.twoFactorMethod === "email"
        ? sessionUser.twoFactorMethod
        : null;
    const hasEstablishedMethod = sessionUser.twoFactorEnabled === true &&
        sessionUser.mustEnrollTwoFactor !== true &&
        currentMethod !== null;
    if (hasEstablishedMethod && currentMethod !== method) {
        throw new ConflictError(
            "Changing an established two-factor method requires a password-bound challenge",
        );
    }

    const proofSession = await verifySubmittedCode(method, methodInput.code);
    const twoFactorRows = await db
        .select({ id: twoFactorTable.id })
        .from(twoFactorTable)
        .where(eq(twoFactorTable.userId, sessionUser.id))
        .limit(2);
    if (twoFactorRows.length !== 1) {
        throw new ConflictError("Two-factor setup authority is unavailable");
    }

    const authority = twoFactorRows[0]!;
    const committedAt = new Date();
    const enrollmentGuard = buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${sessionTable}
        WHERE ${sessionTable.id} = ${proofSession.sessionId}
          AND ${sessionTable.userId} = ${sessionUser.id}
          AND ${sessionTable.token} = ${proofSession.sessionToken}
    ) AND EXISTS (
        SELECT 1 FROM ${twoFactorTable}
        WHERE ${twoFactorTable.id} = ${authority.id}
          AND ${twoFactorTable.userId} = ${sessionUser.id}
    ) AND EXISTS (
        SELECT 1 FROM ${user}
        WHERE ${user.id} = ${sessionUser.id}
          AND ${user.twoFactorEnabled} = ${true}
    )`, "TWO_FACTOR_ENROLLMENT_CONFLICT");
    try {
        await safeBatch(db, [
            enrollmentGuard,
            db.update(twoFactorTable)
                .set({ verified: true, updatedAt: committedAt })
                .where(and(
                    eq(twoFactorTable.id, authority.id),
                    eq(twoFactorTable.userId, sessionUser.id),
                )),
            db.update(user)
                .set({
                    twoFactorEnabled: true,
                    twoFactorMethod: method,
                    mustEnrollTwoFactor: false,
                    updatedAt: committedAt,
                })
                .where(eq(user.id, sessionUser.id)),
            db.update(sessionTable)
                .set({ twoFactorVerified: true, updatedAt: committedAt })
                .where(and(
                    eq(sessionTable.id, proofSession.sessionId),
                    eq(sessionTable.userId, sessionUser.id),
                    eq(sessionTable.token, proofSession.sessionToken),
                )),
        ]);
    } catch (error) {
        if (isBatchGuardError(error, "TWO_FACTOR_ENROLLMENT_CONFLICT")) {
            throw new ConflictError("Two-factor enrollment changed before it could be committed");
        }
        throw error;
    }

    return ok(c, {});
});

const verify2faRoute = createRoute({
    method: "post",
    path: "/2fa/verify",
    operationId: "dashboard.account.two_factor.verify",
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
    if (!sessionToken) {
        throw new UnauthorizedError("Two-factor verification did not return a session proof");
    }

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
});

// ─────────────────────────────────────────
// Account Security
// ─────────────────────────────────────────

const accountSessionSchema = z.object({
    commandId: z.string().regex(/^acs_[A-Za-z0-9_-]{43}$/),
    current: z.boolean(),
    deviceLabel: z.string().max(100),
    deviceType: z.enum(["desktop", "mobile", "tablet", "unknown"]),
    networkHint: z.string().max(100).nullable(),
    twoFactorVerified: z.boolean(),
    impersonated: z.boolean(),
    createdAt: z.string().datetime(),
    lastActiveAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
});

const accountSessionProjection = {
    id: sessionTable.id,
    ipAddress: sessionTable.ipAddress,
    userAgent: sessionTable.userAgent,
    impersonatedBy: sessionTable.impersonatedBy,
    twoFactorVerified: sessionTable.twoFactorVerified,
    createdAt: sessionTable.createdAt,
    updatedAt: sessionTable.updatedAt,
    expiresAt: sessionTable.expiresAt,
};

const MAX_VISIBLE_ACCOUNT_SESSIONS = 25;

function getAccountSessionCommandSecret(env: Env | undefined): string {
    const secret = env?.BETTER_AUTH_SECRET?.trim();
    if (!secret) {
        throw new ServiceUnavailableError("Account session management is unavailable");
    }
    return secret;
}

async function loadActiveCurrentAccountSession(
    db: Database,
    userId: string,
    currentSessionId: string,
    now: Date,
) {
    return db
        .select(accountSessionProjection)
        .from(sessionTable)
        .where(and(
            eq(sessionTable.id, currentSessionId),
            eq(sessionTable.userId, userId),
            gt(sessionTable.expiresAt, now),
        ))
        .get();
}

async function loadVisibleOtherAccountSessions(
    db: Database,
    userId: string,
    currentSessionId: string,
    now: Date,
) {
    return db
        .select(accountSessionProjection)
        .from(sessionTable)
        .where(and(
            eq(sessionTable.userId, userId),
            ne(sessionTable.id, currentSessionId),
            gt(sessionTable.expiresAt, now),
        ))
        .orderBy(desc(sessionTable.updatedAt))
        .limit(MAX_VISIBLE_ACCOUNT_SESSIONS);
}

async function loadVisibleAgentOwnedAccountSessions(
    db: Database,
    userId: string,
    now: Date,
) {
    return db
        .select(accountSessionProjection)
        .from(sessionTable)
        .where(and(
            eq(sessionTable.userId, userId),
            gt(sessionTable.expiresAt, now),
        ))
        .orderBy(desc(sessionTable.updatedAt))
        .limit(MAX_VISIBLE_ACCOUNT_SESSIONS + 1);
}

function activeCurrentAccountSessionGuard(
    userId: string,
    currentSessionId: string,
) {
    return sql`EXISTS (
        SELECT 1
        FROM "session" AS "current_account_session"
        WHERE "current_account_session"."id" = ${currentSessionId}
          AND "current_account_session"."user_id" = ${userId}
          AND "current_account_session"."expires_at" > unixepoch()
    )`;
}

const listAccountSessionsRoute = createRoute({
    method: "get",
    path: "/sessions",
    operationId: "dashboard.account.sessions.list",
    tags: ["Admin - Auth Management"],
    summary: "List active sessions for the current user",
    responses: {
        200: {
            description: "Current user session list",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        sessions: z.array(accountSessionSchema).max(MAX_VISIBLE_ACCOUNT_SESSIONS),
                        hasMore: z.boolean(),
                    })),
                },
            },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(listAccountSessionsRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const currentSession = c.get("session");
    const isAgentPrincipal = Boolean(c.get("agentPrincipal"));

    if (!currentSession && !isAgentPrincipal) {
        throw new UnauthorizedError("No active session found");
    }

    const createCommandId = await createAccountSessionCommandIdFactory(
        getAccountSessionCommandSecret(c.env),
    );

    if (!currentSession) {
        const rows = await loadVisibleAgentOwnedAccountSessions(
            db,
            sessionUser.id,
            new Date(),
        );
        const visibleRows = rows.slice(0, MAX_VISIBLE_ACCOUNT_SESSIONS);
        return ok(c, {
            sessions: await Promise.all(visibleRows.map(async (row) =>
                presentAccountSession(row, "", await createCommandId(row.id))
            )),
            hasMore: rows.length > visibleRows.length,
        });
    }

    const now = new Date();
    const current = await loadActiveCurrentAccountSession(
        db,
        sessionUser.id,
        currentSession.id,
        now,
    );

    if (!current) {
        throw new UnauthorizedError("The current session is no longer active");
    }

    const otherSessions = await loadVisibleOtherAccountSessions(
        db,
        sessionUser.id,
        currentSession.id,
        now,
    );
    const visibleOtherSessions = otherSessions.slice(
        0,
        MAX_VISIBLE_ACCOUNT_SESSIONS - 1,
    );
    const visibleSessions = [current, ...visibleOtherSessions];
    const presentedSessions = await Promise.all(
        visibleSessions.map(async (row) =>
            presentAccountSession(
                row,
                currentSession.id,
                await createCommandId(row.id),
            )
        ),
    );

    return ok(c, {
        sessions: presentedSessions,
        hasMore: otherSessions.length > visibleOtherSessions.length,
    });
});

const revokeAccountSessionRoute = createRoute({
    method: "delete",
    path: "/sessions/{commandId}",
    operationId: "dashboard.account.sessions.revoke",
    tags: ["Admin - Auth Management"],
    summary: "Revoke another session for the current user",
    request: {
        params: z.object({
            commandId: z.string().regex(/^acs_[A-Za-z0-9_-]{43}$/),
        }),
    },
    responses: {
        200: {
            description: "Session revoked",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(revokeAccountSessionRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const currentSession = c.get("session");
    const { commandId } = c.req.valid("param");
    const isAgentPrincipal = Boolean(c.get("agentPrincipal"));

    if (!currentSession && !isAgentPrincipal) {
        throw new UnauthorizedError("No active session found");
    }

    const createCommandId = await createAccountSessionCommandIdFactory(
        getAccountSessionCommandSecret(c.env),
    );
    const now = new Date();
    const candidates = currentSession
        ? await (async () => {
            const current = await loadActiveCurrentAccountSession(
                db,
                sessionUser.id,
                currentSession.id,
                now,
            );
            if (!current) {
                throw new UnauthorizedError("The current session is no longer active");
            }
            if (commandId === await createCommandId(current.id)) {
                throw new ValidationError(
                    "The current session cannot be revoked here. Use Sign out instead.",
                );
            }
            const rows = await loadVisibleOtherAccountSessions(
                db,
                sessionUser.id,
                currentSession.id,
                now,
            );
            return rows.slice(0, MAX_VISIBLE_ACCOUNT_SESSIONS - 1);
        })()
        : (await loadVisibleAgentOwnedAccountSessions(
            db,
            sessionUser.id,
            now,
        )).slice(0, MAX_VISIBLE_ACCOUNT_SESSIONS);
    const candidateCommandIds = await Promise.all(
        candidates.map((candidate) => createCommandId(candidate.id)),
    );
    const targetIndex = candidateCommandIds.indexOf(commandId);
    const targetSessionId = candidates[targetIndex]?.id;
    if (targetIndex < 0 || !targetSessionId) {
        throw new NotFoundError("Session not found");
    }

    const revokeWhere = currentSession
        ? and(
            eq(sessionTable.id, targetSessionId),
            eq(sessionTable.userId, sessionUser.id),
            ne(sessionTable.id, currentSession.id),
            activeCurrentAccountSessionGuard(sessionUser.id, currentSession.id),
        )
        : and(
            eq(sessionTable.id, targetSessionId),
            eq(sessionTable.userId, sessionUser.id),
        );
    const revoked = await db
        .delete(sessionTable)
        .where(revokeWhere)
        .returning({ id: sessionTable.id });

    if (revoked.length === 0) {
        throw new NotFoundError("Session not found");
    }

    return ok(c, { message: "Session signed out successfully" });
});

const revokeOtherAccountSessionsRoute = createRoute({
    method: "delete",
    path: "/sessions",
    operationId: "dashboard.account.sessions.revoke_others",
    tags: ["Admin - Auth Management"],
    summary: "Sign out browser sessions",
    description:
        "A dashboard browser keeps its current session and signs out every other device. An agent credential has no browser session to preserve, so CLI and MCP calls sign out every browser session for the owner.",
    responses: {
        200: {
            description: "Other sessions revoked",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        message: z.string(),
                        revokedCount: z.number().int().nonnegative(),
                    })),
                },
            },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(revokeOtherAccountSessionsRoute, async (c) => {
    const db = c.get("db");
    const sessionUser = c.get("user");
    const currentSession = c.get("session");
    const isAgentPrincipal = Boolean(c.get("agentPrincipal"));

    if (!currentSession && !isAgentPrincipal) {
        throw new UnauthorizedError("No active session found");
    }
    if (!currentSession) {
        const revoked = await db
            .delete(sessionTable)
            .where(eq(sessionTable.userId, sessionUser.id))
            .returning({ id: sessionTable.id });
        return ok(c, {
            message: revoked.length === 0
                ? "No active browser sessions were found"
                : "Browser sessions signed out successfully",
            revokedCount: revoked.length,
        });
    }
    const current = await loadActiveCurrentAccountSession(
        db,
        sessionUser.id,
        currentSession.id,
        new Date(),
    );
    if (!current) {
        throw new UnauthorizedError("The current session is no longer active");
    }

    const revoked = await db
        .delete(sessionTable)
        .where(and(
            eq(sessionTable.userId, sessionUser.id),
            ne(sessionTable.id, currentSession.id),
            activeCurrentAccountSessionGuard(sessionUser.id, currentSession.id),
        ))
        .returning({ id: sessionTable.id });

    return ok(c, {
        message: revoked.length === 0
            ? "No other active sessions were found"
            : "Other sessions signed out successfully",
        revokedCount: revoked.length,
    });
});

const getAccountSecurityRoute = createRoute({
    method: "get",
    path: "/account-security",
    operationId: "dashboard.account.security_get",
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
    return adminPrincipalExists(db);
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
    password: z.string()
        .min(AUTH_PASSWORD_MIN_LENGTH, `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters`)
        .max(AUTH_PASSWORD_MAX_LENGTH, `Password must be at most ${AUTH_PASSWORD_MAX_LENGTH} characters`)
});

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
    const normalizedEmail = email.trim().toLowerCase();
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
            const credential = await prepareCredentialIdentity({
                name,
                email: normalizedEmail,
                password,
            });
            await completeAdminSetupClaimWithCredentialIdentity(
                db,
                setupClaim,
                credential,
            );
            promotedUserId = credential.userId;
            setupClaim = null;

            const { autoSeedRbacIfNeeded } = await import("@scalius/core/auth/rbac/auto-seed");
            await autoSeedRbacIfNeeded(db, kv);

            return created(c, { message: "Admin account created successfully", userId: credential.userId });
        } catch (error: unknown) {
            if (!isCredentialIdentityConflictError(error)) {
                throw error;
            }

            const existingUser = await db
                .select({ id: user.id })
                .from(user)
                .where(eq(user.email, normalizedEmail))
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
                normalizedEmail,
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
