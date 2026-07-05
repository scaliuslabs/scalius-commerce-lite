import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  getRequestCorrelation,
  requestCorrelationMiddleware,
} from "./http-correlation";

function createApp() {
  const app = new Hono();
  app.onError((_error, c) => c.json(getRequestCorrelation(c), 500));
  app.use("*", requestCorrelationMiddleware);
  app.get("/correlation", (c) => c.json(getRequestCorrelation(c)));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  return app;
}

describe("requestCorrelationMiddleware", () => {
  it("preserves a reasonable incoming request id and exposes it on the response", async () => {
    const app = createApp();

    const response = await app.request("/correlation", {
      headers: {
        "X-Request-Id": "req_checkout_1234",
        "CF-Ray": "abc123-DAC",
      },
    });
    const json = await response.json() as { requestId?: string; cfRay?: string };

    expect(response.headers.get("X-Request-Id")).toBe("req_checkout_1234");
    expect(json).toEqual({
      requestId: "req_checkout_1234",
      cfRay: "abc123-DAC",
    });
  });

  it("generates a safe request id when the incoming header is unsafe", async () => {
    const app = createApp();

    const response = await app.request("/correlation", {
      headers: {
        "X-Request-Id": "bad id with spaces",
      },
    });
    const requestId = response.headers.get("X-Request-Id");

    expect(requestId).toBeTruthy();
    expect(requestId).not.toBe("bad id with spaces");
    expect(requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it("keeps the response request id available when a handler throws", async () => {
    const app = createApp();

    const response = await app.request("/boom", {
      headers: {
        "X-Request-Id": "req_error_1234",
      },
    });
    const json = await response.json() as { requestId?: string };

    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-Id")).toBe("req_error_1234");
    expect(json.requestId).toBe("req_error_1234");
  });
});
