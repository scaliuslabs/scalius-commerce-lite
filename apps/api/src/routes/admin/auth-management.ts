import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { user, roles, userRoles, userPermissions, permissions, session as sessionTable } from "@scalius/database/schema";
import { createAuth } from "@scalius/core/auth";
import { sendAdminInviteEmail } from "@scalius/core/integrations/email";
import { assignRoleToUser } from "@scalius/core/auth/rbac/helpers";

const app = new Hono<{
    Variables: {
        db: any;
        user: any;
        session: any;
        env: any;
    };
}>();

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
// Admin Users Management (formerly admin-users.ts)
// ─────────────────────────────────────────

app.get("/users", async (c) => {
    try {
        const db = c.get("db");
        // Verify the user is authenticated and is an admin
        const sessionUser = c.get("user");

        if (sessionUser.role !== "admin") {
            return c.json({ error: "Forbidden", message: "Only administrators can access this resource" }, 403);
        }

        // Get all admin users
        const adminUsers = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                emailVerified: user.emailVerified,
                image: user.image,
                twoFactorEnabled: user.twoFactorEnabled,
                isSuperAdmin: user.isSuperAdmin,
                createdAt: user.createdAt,
            })
            .from(user)
            .where(eq(user.role, "admin"));

        // Get roles for each user
        const usersWithRoles = await Promise.all(
            adminUsers.map(async (adminUser: any) => {
                const userRoleData = await db
                    .select({
                        id: roles.id,
                        name: roles.name,
                        displayName: roles.displayName,
                    })
                    .from(userRoles)
                    .innerJoin(roles, eq(userRoles.roleId, roles.id))
                    .where(eq(userRoles.userId, adminUser.id));

                const overrides = await db
                    .select({
                        permissionName: permissions.name,
                        granted: userPermissions.granted,
                    })
                    .from(userPermissions)
                    .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
                    .where(eq(userPermissions.userId, adminUser.id));

                const grants = overrides.filter((o: any) => o.granted).map((o: any) => o.permissionName);
                const denials = overrides.filter((o: any) => !o.granted).map((o: any) => o.permissionName);

                return {
                    ...adminUser,
                    roles: userRoleData,
                    overrides: { grants, denials },
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
    email: z.email(),
    roleId: z.string().optional(),
});

app.post("/users", zValidator("json", createAdminSchema), async (c) => {
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
            body: { name, email, password: tempPassword },
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
            user: { id: signUpResult.user.id, name, email },
        }, 201);
    } catch (error: any) {
        console.error("Create admin user error:", error);
        return c.json({ error: "Server error", message: error.message || "Failed to create admin user" }, 500);
    }
});

app.delete("/users/:id", async (c) => {
    try {
        const db = c.get("db");
        const sessionUser = c.get("user");
        const userId = c.req.param("id");

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
// Profile & Password (formerly change-password.ts, update-profile.ts)
// ─────────────────────────────────────────

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

app.post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
    try {
        const env = c.get("env") || process.env;
        const auth = createAuth(env);
        const { currentPassword, newPassword } = c.req.valid("json");

        const result = await auth.api.changePassword({
            headers: c.req.raw.headers,
            body: { currentPassword, newPassword, revokeOtherSessions: true },
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
    image: z.url().optional().nullable(),
});

app.post("/update-profile", zValidator("json", updateProfileSchema), async (c) => {
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
// 2FA Management (formerly get-2fa-info.ts, mark-2fa-verified.ts, update-2fa-method.ts, verify-2fa.ts)
// ─────────────────────────────────────────

app.get("/2fa/info", async (c) => {
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
            email: userData.email,
        }, 200);
    } catch (error: any) {
        return c.json({ success: false, message: "Internal server error" }, 500);
    }
});

app.post("/2fa/mark-verified", async (c) => {
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

app.post("/2fa/method", zValidator("json", z.object({ method: z.enum(["totp", "email"]) })), async (c) => {
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

app.post("/2fa/verify", zValidator("json", z.object({ code: z.string(), trustDevice: z.boolean().optional(), type: z.string().optional().default("totp") })), async (c) => {
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
// Setup Endpoint (formerly setup.ts)
// NOTE: This endpoint explicitly BYPASSES normal auth
// ─────────────────────────────────────────

// We define a separate standalone router for unauthenticated routes like `/setup`
const setupApp = new Hono<{
    Bindings: Env;
    Variables: {
        db: any;
    };
}>();

const setupSchema = z.object({
    name: z.string().min(1),
    email: z.email(),
    password: z.string().min(8, "Password must be at least 8 characters"),
});

setupApp.post("/", zValidator("json", setupSchema), async (c) => {
    try {
        const db = c.get("db");
        const env = c.env;
        const auth = createAuth(env);

        // SECURITY CHECK: Only allow setup when NO admin users exist
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

        // Seed RBAC permissions and roles so the dashboard works immediately
        const { autoSeedRbacIfNeeded } = await import("@scalius/core/auth/rbac/auto-seed");
        await autoSeedRbacIfNeeded(db);

        return c.json({ success: true, message: "Admin account created successfully", userId: signUpResult.user.id }, 201);
    } catch (error: any) {
        return c.json({ error: "Server error", message: error.message || "Failed to create admin account" }, 500);
    }
});

export { app as adminAuthManagementRoutes, setupApp as authSetupRoutes };
