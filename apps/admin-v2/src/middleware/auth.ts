/**
 * Auth request middleware for TanStack Start.
 * Fetches the Better Auth session from request cookies.
 * cloudflare:workers is isolated in auth.server.ts (dynamic import).
 */

import { createMiddleware } from "@tanstack/react-start";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  twoFactorEnabled: boolean;
}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

export const authMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    let user: AuthUser | null = null;
    let session: AuthSession | null = null;

    try {
      const { getAuthSession, initBindings } = await import(
        "~/lib/auth.server"
      );
      initBindings();

      const cookieHeader = request.headers.get("cookie") ?? "";
      const headers = new Headers();
      if (cookieHeader) headers.set("cookie", cookieHeader);

      const authResult = await getAuthSession(headers);
      if (authResult) {
        user = authResult.user as AuthUser;
        session = authResult.session as AuthSession;
      }
    } catch (error) {
      console.error("[auth middleware] Failed to get session:", error);
    }

    return next({
      context: {
        user,
        session,
      },
    });
  },
);
