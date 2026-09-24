import { afterEach, describe, expect, it, vi } from "vitest";

import { setPageCspHeader } from "./csp-handler";

function directive(response: Response, name: string): string | undefined {
  return response.headers
    .get("Content-Security-Policy")
    ?.split("; ")
    .find((entry) => entry.startsWith(`${name} `));
}

describe("setPageCspHeader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds merchant sources from the layout payload without any network read", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = setPageCspHeader(
      new Response("ok"),
      { apiBaseUrl: "https://api.example.com" },
      "payments.example.com",
    );
    const csp = response.headers.get("Content-Security-Policy");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(csp).toContain("https://payments.example.com");
    expect(csp).not.toContain("https://*.payments.example.com");
  });

  it("keeps the same effective script policy the storefront relied on", () => {
    const scriptSrc = directive(setPageCspHeader(new Response("ok")), "script-src");

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("https://connect.facebook.net");
    expect(scriptSrc).toContain("https://www.facebook.com");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("inherits canonical API and media origins without broadening to wildcard subdomains", () => {
    const response = setPageCspHeader(new Response("ok"), {
      apiBaseUrl: "https://api.example.com",
      cdnBaseUrl: "https://cdn.example.com",
      mediaUrl: "https://media.example.com",
      storefrontUrl: "https://shop.example.com",
    });
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("https://api.example.com");
    expect(csp).toContain("https://cdn.example.com");
    expect(csp).toContain("https://media.example.com");
    expect(csp).toContain("https://shop.example.com");
    expect(csp).not.toContain("https://*.api.example.com");
    expect(csp).not.toContain("https://*.cdn.example.com");
  });

  it("fails closed for malformed configured platform and merchant sources", () => {
    const response = setPageCspHeader(
      new Response("ok"),
      {
        apiBaseUrl: "https://api.example.com/path",
        cdnBaseUrl: "https://user:pass@cdn.example.com",
        mediaUrl: "https://media.example.com/media",
        storefrontUrl: "javascript:alert(1)",
      },
      "javascript:alert(1),https://safe.example.com/path",
    );
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).not.toContain("javascript:");
    expect(csp).not.toContain("safe.example.com");
    expect(csp).not.toContain("api.example.com/path");
    expect(csp).not.toContain("cdn.example.com");
    expect(csp).not.toContain("media.example.com");
  });

  it("never reads merchant sources from process.env", () => {
    process.env.CSP_ALLOWED = "https://leaked.example.com";
    try {
      const response = setPageCspHeader(new Response("ok"), {
        apiBaseUrl: "https://api.example.com",
      });
      expect(response.headers.get("Content-Security-Policy")).not.toContain(
        "leaked.example.com",
      );
    } finally {
      delete process.env.CSP_ALLOWED;
    }
  });

  it("allows loopback sources only when the API origin is local", () => {
    const local = setPageCspHeader(new Response("ok"), {
      apiBaseUrl: "http://localhost:8787",
      storefrontUrl: "http://localhost:4322",
    });
    expect(local.headers.get("Content-Security-Policy")).toContain("http://localhost:*");
    expect(local.headers.get("Content-Security-Policy")).toContain("http://localhost:8787");

    const production = setPageCspHeader(new Response("ok"), {
      apiBaseUrl: "https://api.example.com",
    });
    expect(production.headers.get("Content-Security-Policy")).not.toContain("http://localhost");
  });

  it("allows the TikTok Pixel browser host", () => {
    const csp = setPageCspHeader(new Response("ok")).headers.get("Content-Security-Policy");

    expect(csp).toContain("https://analytics.tiktok.com");
  });

  it("allows only the supported rich-content video player origins", () => {
    const frameSrc = directive(setPageCspHeader(new Response("ok")), "frame-src");

    expect(frameSrc).toContain("https://www.youtube-nocookie.com");
    expect(frameSrc).toContain("https://player.vimeo.com");
    expect(frameSrc).not.toContain("https://*.youtube.com");
    expect(frameSrc).not.toContain("https://*.vimeo.com");
  });

  it("lists each source once per directive even when lists overlap", () => {
    const csp = setPageCspHeader(
      new Response("ok"),
      { apiBaseUrl: "https://api.example.com", mediaUrl: "https://api.example.com/api/v1/media" },
      "https://www.facebook.com, analytics.tiktok.com, api.example.com",
    ).headers.get("Content-Security-Policy")!;

    for (const entry of csp.split("; ")) {
      const sources = entry.split(" ").slice(1);
      expect(sources, entry.split(" ")[0]).toEqual([...new Set(sources)]);
    }
  });
});
