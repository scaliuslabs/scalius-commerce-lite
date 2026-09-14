// @vitest-environment node

import { describe, expect, it } from "vitest";

import { requestRuntime } from "./api/runtime";
import { getCdnBase } from "./media-url";

describe("getCdnBase", () => {
  it("prefers the dashboard canonical CDN over the platform media host", () => {
    expect(requestRuntime.run({
      IMAGE_CDN_BASE_URL: "https://images.example.test/",
      CDN_DOMAIN_URL: "cdn.example.test",
    }, () => getCdnBase())).toBe("https://images.example.test");
  });

  it("serves production media hosts over HTTPS", () => {
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "cdn.example.test" }, () => getCdnBase()))
      .toBe("https://cdn.example.test");
  });

  it("keeps plain HTTP only for loopback media hosts used by local development", () => {
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "localhost:8787" }, () => getCdnBase()))
      .toBe("http://localhost:8787");
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "http://127.0.0.1:8787/api/v1/media" }, () => getCdnBase()))
      .toBe("http://127.0.0.1:8787/api/v1/media");
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "localhost.example.test" }, () => getCdnBase()))
      .toBe("https://localhost.example.test");
  });

  it("returns an empty base when nothing is configured", () => {
    expect(requestRuntime.run({}, () => getCdnBase())).toBe("");
  });
});
