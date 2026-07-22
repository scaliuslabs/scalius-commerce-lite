import { describe, expect, it } from "vitest";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "./http-security";

describe("HTTP transport security", () => {
  it("permanently redirects public HTTP requests without losing path or query", () => {
    const response = redirectPlaintextRequest(
      new Request("http://dashboard.example.com/auth/login?next=%2Fadmin"),
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://dashboard.example.com/auth/login?next=%2Fadmin",
    );
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("allows HTTPS and loopback HTTP through", () => {
    expect(
      redirectPlaintextRequest(new Request("https://dashboard.example.com/auth/login")),
    ).toBeNull();
    expect(
      redirectPlaintextRequest(new Request("http://localhost:3000/auth/login")),
    ).toBeNull();
    expect(
      redirectPlaintextRequest(new Request("http://127.0.0.1:3000/auth/login")),
    ).toBeNull();
  });

  it("adds HTTPS-only HSTS and the baseline browser protections", async () => {
    const response = applyBaselineSecurityHeaders(
      new Request("https://dashboard.example.com/auth/login"),
      new Response("ok"),
      { frameProtection: "deny" },
    );

    expect(await response.text()).toBe("ok");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("does not emit HSTS on local HTTP responses", () => {
    const response = applyBaselineSecurityHeaders(
      new Request("http://localhost:3000/"),
      new Response("ok"),
    );

    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});
