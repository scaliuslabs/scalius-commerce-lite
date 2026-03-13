// src/server/routes/admin/auth-management.ts
// Admin OpenAPI routes for auth management (users, profile, 2FA, setup).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, count } from "drizzle-orm";
import { user, roles, userRoles, userPermissions, permissions, session as sessionTable } from "@scalius/database/schema";
import { createAuth } from "@scalius/core/auth";
import { sendAdminInviteEmail } from "@scalius/core/integrations/email";
import { assignRoleToUser } from "@scalius/core/auth/rbac/helpers";

const app = new OpenAPIHono();

// Generate a secure random password
function generateTempPassword(length = 16): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let password = "";
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        password += chars[randomValues[i] % chars.length];
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
            return c.json({ error: "Forbidden", message: "Only administrators can access this resource" }, 403);
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
            adminUsers.map(async (adminUser: any) => {
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

                const grants = overrides.filter((o: any) => o.granted).map((o: any) => o.permissionName);
                const denials = overrides.filter((o: any) => !o.granted).map((o: any) => o.permissionName);

                return {
                    ...adminUser,
                    roles: userRoleData,
                    overrides: { grants, denials }
                };
            })
        );

        return c.json({ success: true, users: usersWithRoles }, 200);
    } catch (error: any) {
        console.error("Get admin users error:", error);
        return c.json({ error: "Server error", message: "Failed to fetch admin users" }, 500);
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
            return c.json({ error: "Forbidden", message: "Only administrators can create new admin users" }, 403);
        }

        const { name, email, roleId } = c.req.valid("json");

        if (roleId) {
            const roleExists = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get();
            if (!roleExists) return c.json({ error: "Invalid input", message: "Selected role does not exist" }, 400);
        }

        const existingUser = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
        if (existingUser) return c.json({ error: "Email exists", message: "A user with this email already exists" }, 400);

        const tempPassword = generateTempPassword();

        const signUpResult = await auth.api.signUpEmail({
            body: { name, email, password: tempPassword }
        });

        if (!signUpResult || !signUpResult.user) {
            return c.json({ error: "Failed to create user", message: "Could not create admin user" }, 500);
        }

        await db
            .update(user)
            .set({ role: "admin", emailVerified: true })
            .where(eq(user.id, signUpResult.user.id));

        if (roleId) {
            await assignRoleToUser(db, signUpResult.user.id, roleId, sessionUser.id);
        }

        const baseUrl = env.BETTER_AUTH_URL || env.PUBLIC_API_BASE_URL || process.env.BETTER_AUTH_URL || process.env.PUBLIC_API_BASE_URL || "http://localhost:4321";
        const loginUrl = `${baseUrl}/auth/login`;

        try {
            await sendAdminInviteEmail(email, sessionUser.name, tempPassword, loginUrl);
        } catch (emailError) {
            console.error("Failed to send invitation email:", emailError);
            console.log(`IMPORTANT: Temp password for ${email}: ${tempPassword}`);
        }

        return c.json({
            success: true,
            message: "Admin user created successfully. An invitation email has been sent.",
            user: { id: signUpResult.user.id, name, email }
        }, 201);
    } catch (error: any) {
        console.error("Create admin user error:", error);
        return c.json({ error: "Server error", message: error.message || "Failed to create admin user" }, 500);
    }
});

const deleteUserRoute = createRoute({
    method: "delete",
    path: "/users/{id}",
    tags: ["Admin - Auth Management"],
    summary: "Delete an admin user",
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
            return c.json({ error: "Forbidden", message: "Only administrators can delete admin users" }, 403);
        }

        if (userId === sessionUser.id) {
            return c.json({ error: "Invalid operation", message: "You cannot delete your own account" }, 400);
        }

        const userToDelete = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, userId)).get();
        if (!userToDelete) return c.json({ error: "Not found", message: "User not found" }, 404);
        if (userToDelete.role !== "admin") return c.json({ error: "Invalid operation", message: "Can only delete admin users through this endpoint" }, 400);

        const adminCount = await db.select({ id: user.id }).from(user).where(eq(user.role, "admin"));
        if (adminCount.length <= 1) return c.json({ error: "Invalid operation", message: "Cannot delete the last admin user" }, 400);

        await db.delete(user).where(eq(user.id, userId));

        return c.json({ success: true, message: "Admin user deleted successfully" }, 200);
    } catch (error: any) {
        console.error("Delete admin user error:", error);
        return c.json({ error: "Server error", message: "Failed to delete admin user" }, 500);
    }
});

// ─────────────────────────────────────────
// Profile & Password
// ─────────────────────────────────────────

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, "New password must be at least 8 characters")
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

        if (!result) return c.json({ error: "Failed to change password", message: "Unable to change password. Please check your current password." }, 400);

        return c.json({ success: true, message: "Password changed successfully" }, 200);
    } catch (error: any) {
        console.error("Change password error:", error);
        if (error.message?.includes("password") || error.message?.includes("incorrect")) {
            return c.json({ error: "Invalid password", message: "Current password is incorrect" }, 400);
        }
        return c.json({ error: "Server error", message: "Failed to change password. Please try again." }, 500);
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

        return c.json({ success: true, user: updatedUser }, 200);
    } catch (error: any) {
        console.error("Error updating profile:", error);
        return c.json({ error: "Failed to update profile" }, 500);
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

        if (!userData) return c.json({ success: false, message: "User not found" }, 404);

        return c.json({
            success: true,
            method: userData.twoFactorMethod || "email",
            twoFactorEnabled: userData.twoFactorEnabled,
            email: userData.email
        }, 200);
    } catch (error: any) {
        return c.json({ success: false, message: "Internal server error" }, 500);
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
            return c.json({ error: "Forbidden", message: "Two-factor authentication is not enabled for this account" }, 403);
        }

        await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, session.id));

        return c.json({ success: true, message: "Session marked as 2FA verified" }, 200);
    } catch (error: any) {
        return c.json({ error: "Internal error", message: error.message || "Failed to update session" }, 500);
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

        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ success: false, message: "Internal server error" }, 500);
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
                return c.json({ success: true, message: "Two-factor authentication verified" }, 200);
            }
        }

        const session = c.get("session");
        if (session) {
            await db.update(sessionTable).set({ twoFactorVerified: true }).where(eq(sessionTable.id, session.id));
            return c.json({ success: true, message: "Two-factor authentication verified" }, 200);
        }

        return c.json({ error: "No session", message: "Could not find session to update" }, 401);
    } catch (error: any) {
        if (error.message?.includes("Invalid")) return c.json({ error: "Invalid code", message: "The verification code is invalid or expired" }, 400);
        return c.json({ error: "Verification failed", message: error.message || "Failed to verify code" }, 500);
    }
});

// ─────────────────────────────────────────
// Setup Endpoint (bypasses normal auth)
// ─────────────────────────────────────────

const setupApp = new OpenAPIHono();

const setupSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8, "Password must be at least 8 characters")
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
        const env = c.env;
        const auth = createAuth(env);

        const adminResult = await db.select({ count: count() }).from(user).where(eq(user.role, "admin"));
        const adminExists = adminResult[0]?.count > 0;

        if (adminExists) {
            console.warn(`[SECURITY] Setup endpoint accessed after admin exists. IP: ${c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown"}`);
            return c.json({ error: "Setup already completed", message: "An admin user already exists. Please use the login page." }, 403);
        }

        const { name, email, password } = c.req.valid("json");

        const signUpResult = await auth.api.signUpEmail({ body: { name, email, password } });
        if (!signUpResult || !signUpResult.user) {
            return c.json({ error: "Failed to create account", message: "Could not create user account" }, 500);
        }

        await db.update(user).set({ role: "admin", isSuperAdmin: true, emailVerified: true }).where(eq(user.id, signUpResult.user.id));

        const { autoSeedRbacIfNeeded } = await import("@scalius/core/auth/rbac/auto-seed");
        await autoSeedRbacIfNeeded(db);

        return c.json({ success: true, message: "Admin account created successfully", userId: signUpResult.user.id }, 201);
    } catch (error: any) {
        return c.json({ error: "Server error", message: error.message || "Failed to create admin account" }, 500);
    }
});

export { app as adminAuthManagementRoutes, setupApp as authSetupRoutes };
