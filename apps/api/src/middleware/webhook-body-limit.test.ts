import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MAX_WEBHOOK_BODY_BYTES,
  webhookBodyLimitMiddleware,
} from "./webhook-body-limit";

function createApp() {
  const app = new Hono();
  app.use("*", webhookBodyLimitMiddleware);
  app.post("/", async (c) => c.json({ body: await c.req.text() }));
  return app;
}

describe("webhook body limit", () => {
  it("rejects oversized public webhook payloads before handlers buffer them", async () => {
    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      success: false,
      error: "Webhook payload too large",
    });
  });

  it("preserves accepted payloads for signature verification and parsing", async () => {
    const response = await createApp().request("/", {
      method: "POST",
      body: "signed-provider-payload",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: "signed-provider-payload" });
  });
});
