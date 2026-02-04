// src/pages/api/auth/setup.ts
// Special endpoint for first-time setup that creates an admin user
// SECURITY: This endpoint only works when NO admin users exist in the system

import type { APIRoute } from "astro";
import { getDb } from "@/db";
import { user } from "@/db/schema";
import { count, eq } from "drizzle-orm";
import { createAuth } from "@/lib/auth";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const db = getDb(env);

  try {
    // SECURITY CHECK: Only allow setup when NO admin users exist
    // This ensures setup can only happen once, during initial deployment
    const adminResult = await db
      .select({ count: count() })
      .from(user)
      .where(eq(user.role, "admin"));
    const adminExists = adminResult[0]?.count > 0;

    if (adminExists) {
      // Log security event - someone tried to access setup after it's complete
      console.warn(
        `[SECURITY] Setup endpoint accessed after admin exists. IP: ${
          request.headers.get("cf-connecting-ip") ||
          request.headers.get("x-forwarded-for") ||
          "unknown"
        }`
      );

      return new Response(
        JSON.stringify({
          error: "Setup already completed",
          message: "An admin user already exists. Please use the login page.",
        }),
        {
          status: 403, // Forbidden - this is a security measure
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Parse the request body
    const body = await request.json();
    const { name, email, password } = body;

    // Validate input
    if (!name || !email || !password) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "Name, email, and password are required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (password.length < 8) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "Password must be at least 8 characters",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Use Better Auth's internal API to create the user
    // This ensures proper password hashing
    const auth = createAuth(env);

    const signUpResult = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password,
      },
    });

    if (!signUpResult || !signUpResult.user) {
      return new Response(
        JSON.stringify({
          error: "Failed to create account",
          message: "Could not create user account",
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
        emailVerified: true,
      })
      .where(eq(user.id, signUpResult.user.id));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Admin account created successfully",
        userId: signUpResult.user.id,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Setup error:", error);
    return new Response(
      JSON.stringify({
        error: "Server error",
        message:
          error instanceof Error ? error.message : "Failed to create admin account",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
