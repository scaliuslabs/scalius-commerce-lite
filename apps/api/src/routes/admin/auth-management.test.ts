import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { adminAuthManagementRoutes } from "./auth-management";

function createDbMock(options: { matchingSession?: boolean } = {}) {
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const get = vi.fn(async () =>
    options.matchingSession === false ? null : { id: "session_1" },
  );

  return {
    __updateSet: updateSet,
    __updateWhere: updateWhere,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
}

function createTestApp(
  db: ReturnType<typeof createDbMock>,
  options: { twoFactorEnabled?: boolean; session?: { id: string } | null } = {},
) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", {
      id: "user_1",
      email: "admin@example.com",
      twoFactorEnabled: options.twoFactorEnabled ?? true,
    } as never);
    if (options.session !== null) {
      c.set("session", options.session ?? { id: "session_1" });
    }
    await next();
  });
  app.route("/auth", adminAuthManagementRoutes);
  return app;
}

describe("admin auth management 2FA completion", () => {
  it("marks the current session verified when the Better Auth session-token proof matches", async () => {
    const db = createDbMock();
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/complete-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "session_token_from_successful_2fa_verify" }),
    });

    expect(response.status).toBe(200);
    expect(db.__updateSet).toHaveBeenCalledWith({ twoFactorVerified: true });
    expect(db.__updateWhere).toHaveBeenCalledTimes(1);
  });

  it("rejects completion when the session-token proof does not match the current session", async () => {
    const db = createDbMock({ matchingSession: false });
    const app = createTestApp(db);

    const response = await app.request("/api/v1/admin/auth/2fa/complete-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "session_token_from_another_session_or_guess" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });

  it("rejects completion when 2FA is not enabled for the current account", async () => {
    const db = createDbMock();
    const app = createTestApp(db, { twoFactorEnabled: false });

    const response = await app.request("/api/v1/admin/auth/2fa/complete-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "session_token_from_successful_2fa_verify" }),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(db.__updateSet).not.toHaveBeenCalled();
  });
});
