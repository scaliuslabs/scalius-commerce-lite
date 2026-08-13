import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseFromError } from "../utils/api-response";
import { storefrontAgentContinuationRoutes } from "./storefront-agent-continuations";

const source = readFileSync(
  fileURLToPath(new URL("./storefront-agent-continuations.ts", import.meta.url)),
  "utf8",
);

describe("hosted storefront continuation boundaries", () => {
  it("requires service JWT auth and keeps every response private", () => {
    expect(source).toContain('app.use("*", authMiddleware)');
    expect(source).toContain('Cache-Control", "private, no-cache, no-store, must-revalidate"');
    expect(source).toContain('Referrer-Policy", "no-referrer"');
  });

  it("binds customer and recovered order authority before completing", () => {
    expect(source).toContain("bindAgentStorefrontCustomerSession");
    expect(source).toContain("hashCustomerSessionToken");
    expect(source).toContain("bindAgentStorefrontRecoveredOrder");
    expect(source).toContain("deleteCustomerSession");
  });

  it("keeps OTP queue payloads opaque and clears challenges on queue failure", () => {
    expect(source).toContain("c.env.AUTH_OTP_QUEUE.send(result.queuePayload)");
    expect(source).toContain("deleteCustomerAuthOtpChallenge");
    expect(source).toContain("deleteOrderPaymentRecoveryChallenge");
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*(?:body\.code|result\.session\.token|receiptToken)/);
  });

  it("labels all hosted routes internal so they are never agent-executable", () => {
    const operationIds = [...source.matchAll(/operationId: "([^"]+)"/g)]
      .map((match) => match[1])
      .filter((id): id is string => Boolean(id));
    expect(operationIds).toHaveLength(9);
    expect(operationIds.every((id) => id.startsWith("system.storefront_continuations."))).toBe(true);
    expect(source.match(/security: \[\{ bearerAuth: \[\] \}\]/g)).toHaveLength(9);
  });

  it("rejects a theme preview exchange without service authentication", async () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", {} as never);
      await next();
    });
    app.route("/storefront/agent-continuations", storefrontAgentContinuationRoutes);

    const response = await app.request(
      "/api/v1/storefront/agent-continuations/theme-preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuationCode: `tpc_${"a".repeat(48)}` }),
      },
      { CACHE: {} } as Env,
    );
    expect(response.status).toBe(401);
  });
});
