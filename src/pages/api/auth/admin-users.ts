// src/pages/api/auth/admin-users.ts
// API endpoint for managing admin users

import type { APIRoute } from "astro";
import { getDb } from "@/db";
import { user, roles, userRoles, userPermissions, permissions } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { createAuth } from "@/lib/auth";
import { sendAdminInviteEmail } from "@/lib/email";
import { assignRoleToUser } from "@/lib/rbac/helpers";

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

// GET - List all admin users
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);
  const db = getDb(env);

  try {
    // Verify the user is authenticated and is an admin
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (!sessionResult?.session || !sessionResult?.user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "You must be logged in to access this resource",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (sessionResult.user.role !== "admin") {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "Only administrators can access this resource",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      );
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
      adminUsers.map(async (adminUser) => {
        const userRoleData = await db
          .select({
            id: roles.id,
            name: roles.name,
            displayName: roles.displayName,
          })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(eq(userRoles.userId, adminUser.id));

        // Get permission overrides
        const overrides = await db
          .select({
            permissionName: permissions.name,
            granted: userPermissions.granted,
          })
          .from(userPermissions)
          .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
          .where(eq(userPermissions.userId, adminUser.id));

        const grants = overrides.filter((o) => o.granted).map((o) => o.permissionName);
        const denials = overrides.filter((o) => !o.granted).map((o) => o.permissionName);

        return {
          ...adminUser,
          roles: userRoleData,
          overrides: { grants, denials },
        };
      })
    );

    return new Response(
      JSON.stringify({
        success: true,
        users: usersWithRoles,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Get admin users error:", error);
    return new Response(
      JSON.stringify({
        error: "Server error",
        message: "Failed to fetch admin users",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

// POST - Create a new admin user
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);
  const db = getDb(env);

  try {
    // Verify the user is authenticated and is an admin
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (!sessionResult?.session || !sessionResult?.user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "You must be logged in to access this resource",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (sessionResult.user.role !== "admin") {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "Only administrators can create new admin users",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const body = await request.json();
    const { name, email, roleId } = body;

    // Validate input
    if (!name || !email) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "Name and email are required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate roleId if provided
    if (roleId) {
      const roleExists = await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, roleId))
        .get();

      if (!roleExists) {
        return new Response(
          JSON.stringify({
            error: "Invalid input",
            message: "Selected role does not exist",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Check if email already exists
    const existingUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .get();

    if (existingUser) {
      return new Response(
        JSON.stringify({
          error: "Email exists",
          message: "A user with this email already exists",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Generate a temporary password
    const tempPassword = generateTempPassword();

    // Create the user using Better Auth's API
    const signUpResult = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password: tempPassword,
      },
    });

    if (!signUpResult || !signUpResult.user) {
      return new Response(
        JSON.stringify({
          error: "Failed to create user",
          message: "Could not create admin user",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Update the user's role to admin
    await db
      .update(user)
      .set({
        role: "admin",
        emailVerified: true, // Skip email verification for admin-created users
      })
      .where(eq(user.id, signUpResult.user.id));

    // Assign the selected role if provided
    if (roleId) {
      await assignRoleToUser(db, signUpResult.user.id, roleId, sessionResult.user.id);
    }

    // Get the base URL for the login link
    const baseUrl =
      (env as Record<string, string>)?.BETTER_AUTH_URL ||
      (env as Record<string, string>)?.PUBLIC_API_BASE_URL ||
      process.env.BETTER_AUTH_URL ||
      process.env.PUBLIC_API_BASE_URL ||
      "http://localhost:4321";

    const loginUrl = `${baseUrl}/auth/login`;

    // Send invitation email with temporary password
    try {
      await sendAdminInviteEmail(
        email,
        sessionResult.user.name,
        tempPassword,
        loginUrl,
      );
    } catch (emailError) {
      console.error("Failed to send invitation email:", emailError);
      // Don't fail the request, but log the temp password for manual sharing
      console.log(`IMPORTANT: Temp password for ${email}: ${tempPassword}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Admin user created successfully. An invitation email has been sent.",
        user: {
          id: signUpResult.user.id,
          name,
          email,
        },
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Create admin user error:", error);
    return new Response(
      JSON.stringify({
        error: "Server error",
        message: error instanceof Error ? error.message : "Failed to create admin user",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

// DELETE - Remove an admin user
export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);
  const db = getDb(env);

  try {
    // Verify the user is authenticated and is an admin
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (!sessionResult?.session || !sessionResult?.user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "You must be logged in to access this resource",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (sessionResult.user.role !== "admin") {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "Only administrators can delete admin users",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get("id");

    if (!userId) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "User ID is required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Prevent self-deletion
    if (userId === sessionResult.user.id) {
      return new Response(
        JSON.stringify({
          error: "Invalid operation",
          message: "You cannot delete your own account",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Check if user exists and is an admin
    const userToDelete = await db
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.id, userId))
      .get();

    if (!userToDelete) {
      return new Response(
        JSON.stringify({
          error: "Not found",
          message: "User not found",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (userToDelete.role !== "admin") {
      return new Response(
        JSON.stringify({
          error: "Invalid operation",
          message: "Can only delete admin users through this endpoint",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Count remaining admins
    const adminCount = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.role, "admin"));

    if (adminCount.length <= 1) {
      return new Response(
        JSON.stringify({
          error: "Invalid operation",
          message: "Cannot delete the last admin user",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Delete the user (cascade will handle sessions, accounts, etc.)
    await db.delete(user).where(eq(user.id, userId));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Admin user deleted successfully",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Delete admin user error:", error);
    return new Response(
      JSON.stringify({
        error: "Server error",
        message: "Failed to delete admin user",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
