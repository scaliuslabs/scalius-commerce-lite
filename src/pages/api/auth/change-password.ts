// src/pages/api/auth/change-password.ts
// API endpoint for changing user password

import type { APIRoute } from "astro";
import { createAuth } from "@/lib/auth";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);

  try {
    // Verify the user is authenticated
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (!sessionResult?.session || !sessionResult?.user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "You must be logged in to change your password",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const body = await request.json();
    const { currentPassword, newPassword } = body;

    // Validate input
    if (!currentPassword || !newPassword) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "Current password and new password are required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (newPassword.length < 8) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "New password must be at least 8 characters",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Use Better Auth's changePassword API
    const result = await auth.api.changePassword({
      headers: request.headers,
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: true, // Log out other sessions for security
      },
    });

    if (!result) {
      return new Response(
        JSON.stringify({
          error: "Failed to change password",
          message: "Unable to change password. Please check your current password.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Password changed successfully",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Change password error:", error);

    // Handle specific errors
    if (error instanceof Error) {
      if (error.message.includes("password") || error.message.includes("incorrect")) {
        return new Response(
          JSON.stringify({
            error: "Invalid password",
            message: "Current password is incorrect",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    return new Response(
      JSON.stringify({
        error: "Server error",
        message: "Failed to change password. Please try again.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
