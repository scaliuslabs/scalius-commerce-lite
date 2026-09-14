// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveBackendTarget } from "./backend-target";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveBackendTarget", () => {
  it("uses the service binding with the internal origin in production", async () => {
    vi.stubEnv("DEV", false);
    const bindingFetch = vi.fn(async () => new Response("ok"));
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const target = resolveBackendTarget("/api/v1/customer-auth/logout", {
      fetch: bindingFetch,
    } as unknown as Fetcher);

    expect(target).toMatchObject({
      url: "https://api.internal/api/v1/customer-auth/logout",
      viaServiceBinding: true,
    });
    await target!.fetch(target!.url, { method: "POST" });
    expect(bindingFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/customer-auth/logout",
      { method: "POST" },
    );
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("fails closed in production without the binding", () => {
    vi.stubEnv("DEV", false);
    expect(resolveBackendTarget("/api/v1/customer-auth/logout", undefined)).toBeNull();
  });

  it("uses plain HTTP to the fixed local API port in astro dev, ignoring the binding", async () => {
    vi.stubEnv("DEV", true);
    const bindingFetch = vi.fn();
    const httpFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", httpFetch);

    const target = resolveBackendTarget("api/v1/platform", {
      fetch: bindingFetch,
    } as unknown as Fetcher);

    expect(target).toMatchObject({
      url: "http://localhost:8787/api/v1/platform",
      viaServiceBinding: false,
    });
    await target!.fetch(target!.url);
    expect(httpFetch).toHaveBeenCalledWith("http://localhost:8787/api/v1/platform", undefined);
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});
