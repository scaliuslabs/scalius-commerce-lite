// src/server/routes/admin/auth-management.ts
// Admin OpenAPI routes for auth management (users, profile, 2FA, setup).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, count } from "drizzle-orm";
import { user, roles, userRoles, userPermissions, permissions, session as sessionTable } from "@scalius/database/schema";
import { createAuth } from "@scalius/core/auth";
import { sendAdminInviteEmail } from "@scalius/core/integrations/email";
import { assignRoleToUser } from "@scalius/core/auth/rbac/helpers";

import { ok, created } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError, NotFoundError, ValidationError, ConflictError, RateLimitError } from "../../utils/api-error";
const app = new OpenAPIHono();

// Generate a secure random password
function generateTempPassword(length = 16): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let password = "";
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        password += chars[(randomValues[i] ?? 0) % chars.length];
    }
    return password;
}

// ─────────────────────────────────────────
// Admin Users Management
// ─────────────────────────────────────────

const listUsersRoute = createRoute({
    method: "get",
    path: "/users",
    tags: ["Admin - Auth Management"],
    summary: "List all admin users",
    responses: {
        200: { description: "Admin user list"  }
    }
});

app.openapi(listUsersRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");

        if (sessionUser.role !== "admin") {
            throw new ForbiddenError("Only administrators can access this resource");
        }

        const adminUsers = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                emailVerified: user.emailVerified,
                image: user.image,
                twoFactorEnabled: user.twoFactorEnabled,
                isSuperAdmin: user.isSuperAdmin,
                createdAt: user.createdAt
            })
            .from(user)
            .where(eq(user.role, "admin"));

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
        201: { description: "Admin user created"  }
    }
});

app.openapi(createUserRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const env = c.get("env") || process.env;
        const auth = createAuth(env);

        if (sessionUser.role !== "admin") {
            throw new ForbiddenError("Only administrators can create new admin users");
        }

        const { name, email, roleId } = c.req.valid("json");

        if (roleId) {
            const roleExists = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get();
            if (!roleExists) throw new ValidationError("Selected role does not exist");
        }

        const existingUser = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
        if (existingUser) throw new ConflictError("A user with this email already exists");

        const tempPassword = generateTempPassword();

        const signUpResult = await auth.api.signUpEmail({
            body: { name, email, password: tempPassword }
        });

        if (!signUpResult || !signUpResult.user) {
            throw new Error("Could not create admin user");
        }

        await db
            .update(user)
            .set({ role: "admin", emailVerified: true })
            .where(eq(user.id, signUpResult.user.id));

        if (roleId) {
            await assignRoleToUser(db, signUpResult.user.id, roleId, sessionUser.id);
        }

        const baseUrl = env.BETTER_AUTH_URL || env.PUBLIC_API_BASE_URL;
        if (!baseUrl) throw new Error("BETTER_AUTH_URL or PUBLIC_API_BASE_URL must be configured");
        const loginUrl = `${baseUrl}/auth/login`;

        try {
            await sendAdminInviteEmail(email, sessionUser.name, tempPassword, loginUrl);
        } catch (emailError: unknown) {
            console.error("Failed to send invitation email:", emailError);
            console.log(`IMPORTANT: Temp password for ${email}: ${tempPassword}`);
        }

        return created(c, {
            message: "Admin user created successfully. An invitation email has been sent.",
            user: { id: signUpResult.user.id, name, email }
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
        200: { description: "User deleted"  }
    }
});

app.openapi(deleteUserRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const { id: userId } = c.req.valid("param");

        if (sessionUser.role !== "admin") {
            throw new ForbiddenError("Only administrators can delete admin users");
        }

        if (userId === sessionUser.id) {
            throw new ValidationError("You cannot delete your own account");
        }

        const userToDelete = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, userId)).get();
        if (!userToDelete) throw new NotFoundError("User not found");
        if (userToDelete.role !== "admin") throw new ValidationError("Can only delete admin users through this endpoint");

        const adminCount = await db.select({ id: user.id }).from(user).where(eq(user.role, "admin"));
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
        200: { description: "Password changed"  }
    }
});

app.openapi(changePasswordRoute, async (c) => {
    try {
        const env = c.get("env") || process.env;
        const auth = createAuth(env);
        const { currentPassword, newPassword } = c.req.valid("json");

        const result = await auth.api.changePassword({
            headers: c.req.raw.headers,
            body: { currentPassword, newPassword, revokeOtherSessions: true }
        });

        if (!result) throw new ValidationError("Unable to change password. Please check your current password.");

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
        200: { description: "Profile updated"  }
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
        200: { description: "2FA info"  }
    }
});

app.openapi(get2faInfoRoute, async (c) => {
    try {
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
    } catch (error: unknown) {
        throw error;
    }
});

const mark2faVerifiedRoute = createRoute({
    method: "post",
    path: "/2fa/mark-verified",
    tags: ["Admin - Auth Management"],
    summary: "Mark session as 2FA verified",
    responses: {
        200: { description: "Session marked as verified"  }
    }
});

app.openapi(mark2faVerifiedRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const session = c.get("session");

        if (!sessionUser.twoFactorEnabled) {
            throw new ForbiddenError("Two-factor authentication is not enabled for this account");
        }

        await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, session.id));

        return ok(c, { message: "Session marked as 2FA verified" });
    } catch (error: unknown) {
        throw error;
    }
});

const update2faMethodRoute = createRoute({
    method: "post",
    path: "/2fa/method",
    tags: ["Admin - Auth Management"],
    summary: "Update 2FA method",
    request: {
        body: { content: { "application/json": { schema: z.object({ method: z.enum(["totp", "email"]) }) } } }
    },
    responses: {
        200: { description: "Method updated"  }
    }
});

app.openapi(update2faMethodRoute, async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const { method } = c.req.valid("json");

        await db.update(user).set({ twoFactorMethod: method }).where(eq(user.id, sessionUser.id));

        return ok(c, {});
    } catch (error: unknown) {
        throw error;
    }
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
                        type: z.string().optional().default("totp")
                    })
                }
            }
        }
    },
    responses: {
        200: { description: "2FA verified"  }
    }
});

app.openapi(verify2faRoute, async (c) => {
    try {
        const db = c.get("db");
        const env = c.get("env") || process.env;
        const auth = createAuth(env);
        const { code, trustDevice, type } = c.req.valid("json");

        let verifyResult: { token?: string; user?: { id: string } } | null = null;
        if (type === "backup") {
            verifyResult = await auth.api.verifyBackupCode({ headers: c.req.raw.headers, body: { code } });
        } else {
            verifyResult = await auth.api.verifyTOTP({ headers: c.req.raw.headers, body: { code, trustDevice: trustDevice ?? false } });
        }

        const sessionToken = verifyResult?.token;
        if (sessionToken) {
            const sessionByToken = await db.select({ id: sessionTable.id }).from(sessionTable).where(eq(sessionTable.token, sessionToken)).get();
            if (sessionByToken) {
                await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, sessionByToken.id));
                return ok(c, { message: "Two-factor authentication verified" });
            }
        }

        const session = c.get("session");
        if (session) {
            await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, session.id));
            return ok(c, { message: "Two-factor authentication verified" });
        }

        throw new UnauthorizedError("Could not find session to update");
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("Invalid")) throw new ValidationError("The verification code is invalid or expired");
        throw error;
    }
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
        200: { description: "Account security data" }
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

const setupApp = new OpenAPIHono();

// ── Admin Exists Check (for setup page) ──

const adminExistsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Setup"],
    summary: "Check if any admin user exists",
    responses: {
        200: { description: "Admin exists status" }
    }
});

setupApp.openapi(adminExistsRoute, async (c) => {
    const db = c.get("db");
    const adminResult = await db.select({ count: count() }).from(user).where(eq(user.role, "admin"));
    const adminExists = (adminResult[0]?.count ?? 0) > 0;
    return ok(c, { adminExists });
});

const setupSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(12, "Password must be at least 12 characters")
});

const setupRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Setup"],
    summary: "Initial admin setup (first user only)",
    request: {
        body: { content: { "application/json": { schema: setupSchema } } }
    },
    responses: {
        201: { description: "Admin account created"  }
    }
});

setupApp.openapi(setupRoute, async (c) => {
    try {
        const db = c.get("db");
        const env = c.env as Env;

        // KV-based rate limiting: 5 requests per IP per hour
        const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
        const rateLimitKey = `setup_rate:${ip}`;
        const kv = env.CACHE as KVNamespace | undefined;
        if (kv) {
            const raw = await kv.get(rateLimitKey);
            const attempts = raw ? parseInt(raw, 10) : 0;
            if (attempts >= 5) {
                throw new RateLimitError("Too many setup attempts. Try again later.", 3600);
            }
            await kv.put(rateLimitKey, String(attempts + 1), { expirationTtl: 3600 });
        }

        const auth = createAuth(env);

        const adminResult = await db.select({ count: count() }).from(user).where(eq(user.role, "admin"));
        const adminExists = (adminResult[0]?.count ?? 0) > 0;

        if (adminExists) {
            console.warn(`[SECURITY] Setup endpoint accessed after admin exists. IP: ${c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown"}`);
            throw new ForbiddenError("An admin user already exists. Please use the login page.");
        }

        const { name, email, password } = c.req.valid("json");

        const signUpResult = await auth.api.signUpEmail({ body: { name, email, password } });
        if (!signUpResult || !signUpResult.user) {
            throw new Error("Could not create user account");
        }

        await db.update(user).set({ role: "admin", isSuperAdmin: true, emailVerified: true }).where(eq(user.id, signUpResult.user.id));

        const { autoSeedRbacIfNeeded } = await import("@scalius/core/auth/rbac/auto-seed");
        await autoSeedRbacIfNeeded(db);

        return created(c, { message: "Admin account created successfully", userId: signUpResult.user.id });
    } catch (error: unknown) {
        throw error;
    }
});

export { app as adminAuthManagementRoutes, setupApp as authSetupRoutes };
